/*
  Generador de QR, la página del servicio: la barra para crear, el marco con el
  QR (descargar, compartir, pantalla completa) y la tabla de "Mis QR".

  Esta pantalla NO decide nada: el límite, los 7 días y la revisión del link
  los aplican la base (0044) y la edge function crear-qr. Lo que se valida acá
  es sólo para no hacer esperar a nadie por algo que se ve a simple vista.

  Sin sesión la página se ve completa y se puede pegar el link: al generar, se
  va al login y se vuelve con el link ya escrito (?destino=). Nunca se crea un
  QR solo por volver: la persona aprieta el botón otra vez.

  Depende de: supabase-client.js, auth.service.js, toast.js, confirm-dialog.js,
  qrcode-generator (jsDelivr), qr.nucleo.js, qr.portapapeles.js y qr.imagen.js.
*/
(() => {
  "use strict";

  const RUTA_PAGINA = "/app/features/qr/";
  // El texto más fino de la cuenta regresiva es "N min": repintar cada 30 s
  // basta para que nunca quede más de medio minuto atrasado.
  const INTERVALO_RELOJ_MS = 30 * 1000;
  // PostgREST responde así cuando la tabla o la función todavía no existe: el
  // front se despliega solo y la migración 0044 se aplica a mano, así que por
  // un rato puede pasar (ver el comentario de obtenerPerfil en auth.service.js).
  const SIN_MIGRACION = new Set(["PGRST205", "PGRST202", "42P01", "42883"]);

  const ESTADOS = Object.freeze({ activo: "Activo", vencido: "Vencido", bloqueado: "Bloqueado" });
  // La fecha va en dos renglones (día y hora) y el vencimiento sin año: con
  // "28 sep 2026, 18:03" en una línea, la tabla no cabía en el ancho del sitio.
  const dia = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric" });
  const hora = new Intl.DateTimeFormat("es-MX", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const diaYHora = new Intl.DateTimeFormat("es-MX", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });

  const el = (id) => document.getElementById(id);
  // editando: { id, valor } del QR cuyo nombre se está escribiendo. Vive acá y
  // no en el DOM porque tic() puede repintar la tabla entera a mitad de edición.
  const estado = {
    sesion: null, planes: [], acceso: null, qrs: [], creando: false, enMarco: null, editando: null,
  };

  // --- Datos -----------------------------------------------------------------

  async function cargar() {
    const usuario = estado.sesion.user.id;
    const [planes, acceso, qrs] = await Promise.all([
      supabaseClient.from("qr_planes").select("clave,nombre,limite,duracion,activo"),
      // Filtrado por dueño aunque la RLS ya lo haga: un administrador ve TODAS
      // las filas (policies *_select_admin), y en "Mis QR" sólo van las suyas.
      supabaseClient.from("qr_acceso")
        .select("plan,ilimitado,bloqueado,bloqueo_motivo")
        .eq("user_id", usuario)
        .maybeSingle(),
      supabaseClient.from("qr_codigos")
        .select("id,codigo,destino,titulo,creado_en,vence_en,bloqueado_en,bloqueo_motivo,qr_escaneos(count)")
        .eq("usuario_id", usuario)
        .is("eliminado_en", null)
        .order("creado_en", { ascending: false }),
    ]);
    const error = planes.error || acceso.error || qrs.error;
    if (error) throw error;
    estado.planes = planes.data;
    estado.acceso = acceso.data;
    estado.qrs = qrs.data.map(({ qr_escaneos: escaneos, ...qr }) => ({
      ...qr,
      escaneos: escaneos?.[0]?.count ?? 0,
    }));
  }

  const qrPorCodigo = (codigo) => estado.qrs.find((qr) => qr.codigo === codigo) ?? null;
  const activo = (qr, ahora = Date.now()) => qr && estadoQR(qr, ahora) === "activo";

  // --- Pintado ---------------------------------------------------------------

  function pintar() {
    const ahora = Date.now();
    const cupo = cupoQR({ planes: estado.planes, acceso: estado.acceso, qrs: estado.qrs, ahora });
    el("qrCupo").textContent = cupo.motivo === "cuenta_bloqueada" ? "" : textoCupoQR(cupo);
    pintarLimite(cupo);
    el("qrGenerar").disabled = estado.creando || !cupo.puedeCrear;

    // El marco muestra el elegido si sigue activo; si no, el activo más reciente.
    if (!activo(qrPorCodigo(estado.enMarco), ahora)) {
      estado.enMarco = estado.qrs.find((qr) => activo(qr, ahora))?.codigo ?? null;
    }
    pintarMarco(ahora);
    pintarTabla(ahora);
  }

  function pintarLimite(cupo) {
    const aviso = el("qrLimite");
    aviso.hidden = cupo.puedeCrear;
    if (cupo.puedeCrear) return;
    if (cupo.motivo !== "cuenta_bloqueada") {
      aviso.textContent = mensajeErrorQR(cupo.motivo);
      return;
    }
    // Una cuenta bloqueada necesita saber por qué y a dónde escribir: sin el
    // enlace, "escríbenos" es un callejón sin salida.
    const motivo = estado.acceso?.bloqueo_motivo;
    const contacto = document.createElement("a");
    contacto.href = "/#contacto";
    contacto.textContent = "escríbenos";
    aviso.replaceChildren(
      `Tu cuenta no puede crear QR.${motivo ? ` Motivo: ${motivo}.` : ""} Si crees que es un error, `,
      contacto,
      ".",
    );
  }

  function textoTiempo(qr, ahora) {
    const { vencido, texto } = tiempoRestanteQR(qr.vence_en, ahora);
    if (!vencido) return texto.replace(/^Vence en /, "");
    return `Venció el ${diaYHora.format(new Date(qr.vence_en))}`;
  }

  function pintarMarco(ahora) {
    const qr = qrPorCodigo(estado.enMarco);
    const hayQR = activo(qr, ahora);
    el("qrMarcoVacio").hidden = hayQR;
    el("qrMarcoImagen").hidden = !hayQR;
    for (const id of ["qrMarcoDescargar", "qrMarcoCompartir", "qrMarcoPantalla"]) el(id).disabled = !hayQR;
    if (!hayQR) {
      el("qrMarcoImagen").replaceChildren();
      el("qrMarcoNombre").hidden = true;
      el("qrMarcoLink").textContent = "";
      el("qrMarcoTiempo").textContent = "";
      cerrarMenu();
      return;
    }
    // Sólo se redibuja si cambió el QR: la cuenta regresiva no mueve el dibujo.
    if (el("qrMarcoImagen").dataset.codigo !== qr.codigo) {
      // El SVG lo arma svgQR(): el código es [2-9a-hjkmnp-z]{6} por constraint
      // de la base y la etiqueta va escapada: no hay HTML ajeno que inyectar.
      el("qrMarcoImagen").innerHTML = svgQRDeCodigo(qr.codigo);
      el("qrMarcoImagen").dataset.codigo = qr.codigo;
    }
    el("qrMarcoNombre").hidden = !qr.titulo;
    el("qrMarcoNombre").textContent = qr.titulo ?? "";
    el("qrMarcoLink").textContent = urlVisibleQR(qr.codigo);
    el("qrMarcoTiempo").textContent = tiempoRestanteQR(qr.vence_en, ahora).texto;
  }

  function pintarTabla(ahora) {
    const hayQRs = estado.qrs.length > 0;
    el("qrTablaMarco").hidden = !hayQRs;
    el("qrListaEstado").hidden = hayQRs;
    if (!hayQRs) el("qrListaEstado").textContent = "Todavía no tienes QR. Pega un link arriba para crear el primero.";
    // Si se repinta mientras alguien escribe el nombre, el foco vuelve al campo.
    const escribiendo = Boolean(document.activeElement?.closest?.(".qr__tabla-editor"));
    el("qrFilas").replaceChildren(...estado.qrs.map((qr) => crearFila(qr, ahora)));
    if (escribiendo) el("qrFilas").querySelector(".qr__tabla-editor:not([hidden]) input")?.focus();
  }

  function crearFila(qr, ahora) {
    const fila = el("qrPlantillaFila").content.firstElementChild.cloneNode(true);
    const campo = (nombre) => fila.querySelector(`[data-qr="${nombre}"]`);
    const estadoActual = estadoQR(qr, ahora);
    const esActivo = estadoActual === "activo";

    fila.dataset.id = String(qr.id);
    fila.dataset.estado = estadoActual;
    fila.classList.toggle("qr__tabla-fila--elegida", qr.codigo === estado.enMarco);
    const creado = new Date(qr.creado_en);
    const horaCreado = document.createElement("span");
    horaCreado.className = "qr__tabla-hora";
    horaCreado.textContent = hora.format(creado);
    campo("fecha").replaceChildren(dia.format(creado), horaCreado);
    campo("nombre").hidden = !qr.titulo;
    campo("nombre").textContent = qr.titulo ?? "";
    // Un QR bloqueado (o la cuenta) no se renombra: qr_renombrar lo rechaza (0052).
    const renombrable = estadoActual !== "bloqueado" && !estado.acceso?.bloqueado;
    const editando = renombrable && estado.editando?.id === qr.id;
    campo("titulo").hidden = editando || (!renombrable && !qr.titulo);
    const renombrar = fila.querySelector('[data-accion="renombrar"]');
    renombrar.hidden = !renombrable;
    campo("renombrar-texto").hidden = Boolean(qr.titulo);
    renombrar.setAttribute("aria-label", qr.titulo
      ? `Editar el nombre del QR ${urlVisibleQR(qr.codigo)}`
      : `Agregar un nombre al QR ${urlVisibleQR(qr.codigo)}`);
    renombrar.title = qr.titulo ? "Editar el nombre" : "";
    campo("editor").hidden = !editando;
    if (editando) campo("editor").querySelector("input").value = estado.editando.valor;
    campo("destino").textContent = qr.destino;
    campo("destino").title = `Copiar ${qr.destino}`;
    const link = campo("link");
    link.textContent = urlVisibleQR(qr.codigo);
    // El link corto se copia como el destino; al marco se llega con la fila.
    // Uno vencido o bloqueado no se ofrece: copiar un link muerto no sirve.
    if (esActivo) {
      link.dataset.accion = "copiar-link";
      link.tabIndex = 0;
      link.removeAttribute("aria-disabled");
    } else {
      delete link.dataset.accion;
      link.removeAttribute("tabindex");
      link.setAttribute("aria-disabled", "true");
    }
    link.title = esActivo ? `Copiar ${urlCortaQR(qr.codigo)}` : "Este QR ya no funciona";
    // Sin mouse, la fila activa se elige con Enter o Espacio.
    if (esActivo) fila.tabIndex = 0;
    else fila.removeAttribute("tabindex");
    const insignia = campo("estado");
    insignia.textContent = ESTADOS[estadoActual];
    insignia.dataset.estado = estadoActual;
    const motivo = campo("motivo");
    motivo.hidden = estadoActual !== "bloqueado";
    if (estadoActual === "bloqueado") motivo.textContent = qr.bloqueo_motivo;
    campo("tiempo").textContent = textoTiempo(qr, ahora);
    campo("escaneos").textContent = String(qr.escaneos ?? 0);

    const descargar = fila.querySelector('[data-accion="descargar"]');
    descargar.disabled = !esActivo;
    descargar.title = esActivo ? "" : "Un QR que ya no funciona no se descarga";
    descargar.setAttribute("aria-label", `Descargar el QR ${urlVisibleQR(qr.codigo)}`);
    fila.querySelector('[data-accion="eliminar"]')
      .setAttribute("aria-label", `Eliminar el QR ${urlVisibleQR(qr.codigo)}`);
    return fila;
  }

  // Cada 30 s: sólo los textos de tiempo, salvo que algún QR haya vencido, que
  // mueve el cupo y el marco y obliga a repintar todo.
  function tic() {
    const ahora = Date.now();
    const filas = new Map([...el("qrFilas").children].map((nodo) => [nodo.dataset.id, nodo]));
    if (estado.qrs.some((qr) => filas.get(String(qr.id))?.dataset.estado !== estadoQR(qr, ahora))) {
      pintar();
      return;
    }
    for (const qr of estado.qrs) {
      const tiempo = filas.get(String(qr.id))?.querySelector('[data-qr="tiempo"]');
      if (tiempo) tiempo.textContent = textoTiempo(qr, ahora);
    }
    const enMarco = qrPorCodigo(estado.enMarco);
    if (enMarco) el("qrMarcoTiempo").textContent = tiempoRestanteQR(enMarco.vence_en, ahora).texto;
  }

  // --- Generar ---------------------------------------------------------------

  function avisoFormulario(mensaje) {
    const aviso = el("qrFormularioEstado");
    aviso.textContent = mensaje;
    aviso.hidden = !mensaje;
    el("qrDestino").setAttribute("aria-invalid", mensaje ? "true" : "false");
  }

  // Un error de la edge function trae su cuerpo en `context` (la Response).
  async function cuerpoDeError(error) {
    try {
      return await error.context.json();
    } catch {
      return null;
    }
  }

  async function generar(evento) {
    evento.preventDefault();
    if (estado.creando) return;
    const destino = el("qrDestino").value.trim();
    const titulo = el("qrNombre").value.trim();

    if (!estado.sesion) {
      const parametros = new URLSearchParams();
      if (destino) parametros.set("destino", destino);
      if (titulo) parametros.set("nombre", titulo);
      const consulta = parametros.toString();
      window.location.href = urlLoginConDestino(`${RUTA_PAGINA}${consulta ? `?${consulta}` : ""}`);
      return;
    }

    const previa = validarFormularioQR({ destino, titulo });
    if (!previa.ok) {
      avisoFormulario(mensajeErrorQR(previa.codigo));
      el(previa.codigo === "titulo_largo" ? "qrNombre" : "qrDestino").focus();
      return;
    }

    const boton = el("qrGenerar");
    const textoOriginal = boton.textContent;
    estado.creando = true;
    boton.disabled = true;
    boton.textContent = boton.dataset.loadingText;
    avisoFormulario("");

    try {
      const { data, error } = await supabaseClient.functions.invoke("crear-qr", {
        body: { destino, titulo: titulo || null },
      });
      if (error) {
        const cuerpo = await cuerpoDeError(error);
        avisoFormulario(mensajeErrorQR(cuerpo?.code, cuerpo?.detalle));
        // Si el servidor dice que no hay lugar, la lista de esta pestaña quedó
        // vieja (otra pestaña creó uno): se relee para que el cupo diga la verdad.
        if (cuerpo?.code === "limite_alcanzado" || cuerpo?.code === "cuenta_bloqueada") await cargar();
        return;
      }
      el("qrFormulario").reset();
      estado.qrs.unshift({ ...data.qr, bloqueado_en: null, bloqueo_motivo: null, escaneos: 0 });
      estado.enMarco = data.qr.codigo;
      mostrarToast("QR creado. Ya puedes descargarlo o compartirlo.");
    } catch (error) {
      console.error(error);
      avisoFormulario(MENSAJE_ERROR_QR_GENERICO);
    } finally {
      estado.creando = false;
      boton.textContent = textoOriginal;
      pintar();
    }
  }

  // --- Marco: descargar, compartir, pantalla completa -----------------------

  function cerrarMenu() {
    el("qrMenuDescargar").hidden = true;
    el("qrMarcoDescargar").setAttribute("aria-expanded", "false");
  }

  function alternarMenu() {
    const abrir = el("qrMenuDescargar").hidden;
    el("qrMenuDescargar").hidden = !abrir;
    el("qrMarcoDescargar").setAttribute("aria-expanded", String(abrir));
    if (abrir) el("qrMenuDescargar").querySelector("button").focus();
  }

  async function descargarDelMarco(formato) {
    cerrarMenu();
    const qr = qrPorCodigo(estado.enMarco);
    if (!activo(qr)) return;
    if (formato === "svg") await descargarSvgQR(qr.codigo);
    else await descargarPngQR(qr.codigo);
  }

  /*
    Compartir, de mejor a peor según lo que el navegador permita: la imagen
    como archivo (celulares: WhatsApp, correo…), el link por la hoja de
    compartir del sistema, o copiar el link. Cancelar la hoja no es un error.
  */
  async function compartir() {
    const qr = qrPorCodigo(estado.enMarco);
    if (!activo(qr)) return;
    const url = urlCortaQR(qr.codigo);
    try {
      if (typeof navigator.canShare === "function") {
        const archivo = new File([await pngQRBlob(qr.codigo)], `qr-${qr.codigo}.png`, { type: "image/png" });
        if (navigator.canShare({ files: [archivo] })) {
          await navigator.share({ files: [archivo], title: "Código QR", text: url });
          return;
        }
      }
      if (typeof navigator.share === "function") {
        await navigator.share({ title: "Código QR", url });
        return;
      }
      await navigator.clipboard.writeText(url);
      mostrarToast("Link copiado. Pégalo donde quieras compartirlo.");
    } catch (error) {
      if (error?.name === "AbortError") return;
      console.error(error);
      mostrarToast("No se pudo compartir. Descarga el QR y compártelo desde tus archivos.", "error");
    }
  }

  function abrirPantallaCompleta() {
    const qr = qrPorCodigo(estado.enMarco);
    if (!activo(qr)) return;
    el("qrPantallaImagen").innerHTML = svgQRDeCodigo(qr.codigo);
    el("qrPantallaNombre").hidden = !qr.titulo;
    el("qrPantallaNombre").textContent = qr.titulo ?? "";
    el("qrPantallaLink").textContent = urlVisibleQR(qr.codigo);
    const pantalla = el("qrPantalla");
    pantalla.showModal();
    // Pantalla completa de verdad donde exista la API (no en iPhone): ahí el
    // diálogo, que ya cubre la ventana, es lo único que hay. Sin la API,
    // `?.()` da undefined: por eso el catch va con `?.` también. Se pide sobre
    // el diálogo y no sobre la página: así lo que ocupa la pantalla es el QR.
    pantalla.requestFullscreen?.()?.catch(() => {});
  }

  function cerrarPantallaCompleta() {
    if (el("qrPantalla").open) el("qrPantalla").close();
    if (document.fullscreenElement) document.exitFullscreen?.()?.catch(() => {});
  }

  // --- Tabla -----------------------------------------------------------------

  async function eliminar(qr, boton) {
    const confirmado = await confirmarConTexto({
      titulo: "¿Eliminar este QR?",
      mensaje: `${urlVisibleQR(qr.codigo)} dejará de funcionar de inmediato, aunque ya esté impreso. No se puede deshacer.`,
      etiquetaConfirmar: "Eliminar",
    });
    if (!confirmado) return;
    boton.disabled = true;
    const { data, error } = await supabaseClient.rpc("qr_eliminar", { p_id: qr.id });
    if (error || data !== true) {
      boton.disabled = false;
      throw error ?? new Error("qr_eliminar no eliminó nada");
    }
    estado.qrs = estado.qrs.filter((otro) => otro.id !== qr.id);
    pintar();
    // Después de que el diálogo cerró: el top layer del <dialog> taparía el toast.
    mostrarToast("QR eliminado.");
  }

  function abrirEditorNombre(qr) {
    estado.editando = { id: qr.id, valor: qr.titulo ?? "" };
    pintarTabla(Date.now());
    const campo = el("qrFilas").querySelector(`[data-id="${qr.id}"] .qr__tabla-editor input`);
    campo?.focus();
    campo?.select();
  }

  function cerrarEditorNombre() {
    const id = estado.editando?.id;
    estado.editando = null;
    pintarTabla(Date.now());
    el("qrFilas").querySelector(`[data-id="${id}"] [data-accion="renombrar"]`)?.focus();
  }

  async function guardarNombre(qr, editor) {
    const validado = validarNombreQR(editor.querySelector("input").value);
    if (!validado.ok) {
      mostrarToast(mensajeErrorQR(validado.codigo), "error");
      return;
    }
    if (validado.titulo === (qr.titulo ?? null)) {
      cerrarEditorNombre();
      return;
    }
    const controles = editor.querySelectorAll("input, button");
    for (const control of controles) control.disabled = true;
    try {
      const { data, error } = await supabaseClient.rpc("qr_renombrar", { p_id: qr.id, p_titulo: validado.titulo ?? "" });
      if (error || data !== true) throw error ?? new Error("qr_renombrar no cambió nada");
    } catch (error) {
      for (const control of controles) control.disabled = false;
      throw error;
    }
    qr.titulo = validado.titulo;
    estado.editando = null;
    pintar();
    el("qrFilas").querySelector(`[data-id="${qr.id}"] [data-accion="renombrar"]`)?.focus();
    mostrarToast(validado.titulo ? "Nombre guardado." : "Nombre quitado.");
  }

  function qrDeFila(nodo) {
    const fila = nodo?.closest("[data-id]");
    return (fila && estado.qrs.find((otro) => String(otro.id) === fila.dataset.id)) ?? null;
  }

  async function alEnviarNombre(evento) {
    const editor = evento.target.closest(".qr__tabla-editor");
    if (!editor) return;
    evento.preventDefault();
    const qr = qrDeFila(editor);
    if (!qr) return;
    try {
      await guardarNombre(qr, editor);
    } catch (error) {
      console.error(error);
      mostrarToast("No se pudo guardar el nombre. Intenta de nuevo.", "error");
    }
  }

  function verEnMarco(qr) {
    estado.enMarco = qr.codigo;
    pintar();
    el("qrMarco").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // El destino y el link corto se copian con un clic (qr.portapapeles.js).
  function copiar(qr, nodo) {
    return nodo.dataset.accion === "copiar-link"
      ? copiarConAvisoQR(nodo, urlCortaQR(qr.codigo), "Link del QR")
      : copiarConAvisoQR(nodo, qr.destino, "Link");
  }

  // Dónde empezó el clic: si el puntero se movió, era alguien seleccionando
  // texto con el mouse, no eligiendo la fila.
  let inicioClic = null;

  // Clic en la fila (fuera de sus botones y campos): el QR va al marco para
  // volver a descargarlo. Sólo los activos; uno vencido o bloqueado no se dibuja.
  function elegirFila(evento, qr) {
    if (evento.target.closest("button, input, form, a")) return;
    const arrastre = inicioClic &&
      Math.hypot(evento.clientX - inicioClic.x, evento.clientY - inicioClic.y) > 5;
    if (arrastre || !activo(qr)) return;
    verEnMarco(qr);
  }

  async function alHacerClickEnTabla(evento) {
    const qr = qrDeFila(evento.target);
    if (!qr) return;
    const boton = evento.target.closest("[data-accion]");
    if (!boton) {
      elegirFila(evento, qr);
      return;
    }
    if (boton.disabled) return;

    try {
      if (boton.dataset.accion === "copiar-destino" || boton.dataset.accion === "copiar-link") {
        await copiar(qr, boton);
      } else if (boton.dataset.accion === "descargar") {
        boton.disabled = true;
        try {
          await descargarPngQR(qr.codigo);
        } finally {
          boton.disabled = false;
        }
      } else if (boton.dataset.accion === "eliminar") {
        await eliminar(qr, boton);
      } else if (boton.dataset.accion === "renombrar") {
        abrirEditorNombre(qr);
      } else if (boton.dataset.accion === "cancelar-nombre") {
        cerrarEditorNombre();
      }
    } catch (error) {
      console.error(error);
      mostrarToast("No se pudo completar la acción. Intenta de nuevo.", "error");
    }
  }

  // --- Arranque --------------------------------------------------------------

  function conectar() {
    el("qrFormulario").addEventListener("submit", generar);
    el("qrDestino").addEventListener("input", () => avisoFormulario(""));
    el("qrFilas").addEventListener("click", alHacerClickEnTabla);
    el("qrFilas").addEventListener("submit", alEnviarNombre);
    el("qrFilas").addEventListener("input", (evento) => {
      if (estado.editando && evento.target.closest(".qr__tabla-editor")) estado.editando.valor = evento.target.value;
    });
    el("qrFilas").addEventListener("keydown", (evento) => {
      if (evento.key === "Escape" && evento.target.closest(".qr__tabla-editor")) cerrarEditorNombre();
      // El destino y el link corto son <span> enfocables, no botones: Enter
      // los copia igual que el clic. Enter o Espacio sobre la fila la elige.
      const qr = qrDeFila(evento.target);
      if (!qr) return;
      const copiable = evento.target.closest('[data-accion="copiar-destino"], [data-accion="copiar-link"]');
      if (evento.key === "Enter" && copiable) {
        evento.preventDefault();
        copiar(qr, copiable);
      } else if ((evento.key === "Enter" || evento.key === " ") && evento.target.matches("tr") && activo(qr)) {
        evento.preventDefault();
        verEnMarco(qr);
      }
    });
    el("qrFilas").addEventListener("pointerdown", (evento) => {
      inicioClic = { x: evento.clientX, y: evento.clientY };
    });

    el("qrMarcoDescargar").addEventListener("click", alternarMenu);
    for (const opcion of el("qrMenuDescargar").querySelectorAll("[data-formato]")) {
      opcion.addEventListener("click", () => descargarDelMarco(opcion.dataset.formato).catch((error) => {
        console.error(error);
        mostrarToast("No se pudo descargar. Intenta de nuevo.", "error");
      }));
    }
    document.addEventListener("click", (evento) => {
      if (!evento.target.closest(".qr__descargar")) cerrarMenu();
    });
    document.addEventListener("keydown", (evento) => {
      if (evento.key === "Escape" && !el("qrMenuDescargar").hidden) {
        cerrarMenu();
        el("qrMarcoDescargar").focus();
      }
    });
    el("qrMarcoCompartir").addEventListener("click", compartir);
    el("qrMarcoPantalla").addEventListener("click", abrirPantallaCompleta);
    el("qrPantallaCerrar").addEventListener("click", cerrarPantallaCompleta);
    el("qrPantalla").addEventListener("close", cerrarPantallaCompleta);
    // Salir de pantalla completa con Esc (el navegador se come la primera
    // tecla) también cierra el diálogo: si no, quedaba abierto a medias.
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement && el("qrPantalla").open) el("qrPantalla").close();
    });
  }

  // ?destino= y ?nombre= los deja la vuelta del login: se escriben en el
  // formulario y se limpian de la URL, para que recargar no los repita.
  function recuperarDestino() {
    const parametros = new URLSearchParams(window.location.search);
    const destino = parametros.get("destino");
    const nombre = parametros.get("nombre");
    if (!destino && !nombre) return;
    if (destino) el("qrDestino").value = destino.slice(0, 2048);
    if (nombre) el("qrNombre").value = nombre.slice(0, 80);
    parametros.delete("destino");
    parametros.delete("nombre");
    const resto = parametros.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${resto ? `?${resto}` : ""}${window.location.hash}`);
  }

  function pintarSinSesion() {
    el("qrCupo").textContent = "Gratis con tu cuenta de Taudux: hasta 5 QR activos, cada uno dura 7 días.";
    el("qrListaEstado").textContent = "Inicia sesión para ver, descargar y eliminar tus QR.";
    const acceder = el("qrIrALogin");
    acceder.href = urlLoginConDestino(RUTA_PAGINA);
    acceder.hidden = false;
    pintarMarco(Date.now());
  }

  async function iniciar() {
    conectar();
    recuperarDestino();
    try {
      const sesion = await obtenerSesion();
      if (!sesion) {
        pintarSinSesion();
        return;
      }
      estado.sesion = sesion;
      // Sin botón «Moderación» desde el 2026-10-02: la moderación se abre desde
      // Administración (menú de la cuenta → QR), así que acá no hace falta
      // preguntar si quien entra es administrador.
      await cargar();
      pintar();
      setInterval(tic, INTERVALO_RELOJ_MS);
    } catch (error) {
      console.error(error);
      el("qrListaEstado").textContent = SIN_MIGRACION.has(error?.code)
        ? "El generador de QR todavía no está disponible. Vuelve pronto."
        : "No pudimos cargar tus QR. Recarga la página para intentarlo de nuevo.";
      el("qrGenerar").disabled = true;
    }
  }

  // Este script va al final del <body>: el DOM ya está listo, y esperar
  // DOMContentLoaded sería esperar algo que probablemente ya pasó (admin.js
  // del extractor, 2026-08-19).
  iniciar();
})();
