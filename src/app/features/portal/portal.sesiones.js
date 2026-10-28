/*
  «Sesiones activas» en «Acceso y seguridad» (T5 de sesiones-activas): la lista
  y el detalle de cada sesión. Los estados, plazos y textos salen de
  sesiones.nucleo.js; acá sólo se pide la lista, se dibuja y se cierra.

  Todo se escribe con textContent: la ciudad viene de Vercel y el navegador del
  user agent de otro dispositivo, así que nada de eso se trata como HTML.

  La lista se pide al abrir el portal, tras cada cierre y cada ~60 s con la
  pestaña visible y la sección a la vista (L30). Si la sesión que se está viendo
  en detalle deja de estar abierta, se vuelve a la lista con un aviso (L32).

  Depende de sesiones.nucleo.js, sesiones.service.js (dispositivoDesde),
  auth.service.js, auth-identidades.js, auth-ui.js, toast.js y confirm-dialog.js.
*/

const SESIONES_REFRESCO_MS = 60 * 1000;
const SVG_NS = "http://www.w3.org/2000/svg";

function configurarSesionesActivas(session) {
  const raiz = document.getElementById("sesiones");
  const vistaLista = document.getElementById("sesionesLista");
  const contenido = document.getElementById("sesionesContenido");
  const aviso = document.getElementById("sesionesAviso");
  const vistaDetalle = document.getElementById("sesionesDetalle");
  const titulo = document.getElementById("tituloSesiones");
  if (!raiz || !vistaLista || !contenido || !aviso || !vistaDetalle) return;

  const seccion = raiz.closest(".portal__section");
  const tieneContrasena = puedeUsarContrasena(session.user);
  const estado = {
    filas: null,
    fallo: false,
    cargando: false,
    recargar: false,
    detalleId: null,
    cerradasVisibles: CERRADAS_POR_PAGINA,
    inactivasAbiertas: false,
    cerradasAbiertas: false,
  };

  function el(etiqueta, atributos = {}, ...hijos) {
    const nodo = document.createElement(etiqueta);
    for (const [clave, valor] of Object.entries(atributos)) {
      if (valor === null || valor === undefined || valor === false) continue;
      if (clave === "class") nodo.className = valor;
      else if (clave === "texto") nodo.textContent = valor;
      else if (clave.startsWith("on")) nodo.addEventListener(clave.slice(2), valor);
      else nodo.setAttribute(clave, valor === true ? "" : String(valor));
    }
    nodo.append(...hijos.filter((hijo) => hijo !== null && hijo !== undefined && hijo !== false));
    return nodo;
  }

  function icono(tipo) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "sesiones__icono");
    const formas =
      tipo === "movil"
        ? [["rect", { x: 7, y: 2, width: 10, height: 20, rx: 2 }], ["path", { d: "M11 18h2" }]]
        : [["rect", { x: 2, y: 4, width: 20, height: 13, rx: 2 }], ["path", { d: "M8 21h8M12 17v4" }]];
    for (const [nombre, atributos] of formas) {
      const forma = document.createElementNS(SVG_NS, nombre);
      for (const [clave, valor] of Object.entries(atributos)) forma.setAttribute(clave, String(valor));
      svg.append(forma);
    }
    return svg;
  }

  // Una sesión sin latido todavía no tiene navegador guardado: se lee de su
  // user agent con el mismo intérprete que usa el latido (S13).
  function dispositivoDeFila(fila) {
    if (fila.navegador || fila.sistema) return fila;
    if (typeof dispositivoDesde === "function") return dispositivoDesde(fila.user_agent, null);
    return {};
  }

  function insignia(estadoSesion) {
    return el("span", {
      class: `sesiones__insignia sesiones__insignia--${estadoSesion}`,
      texto: ETIQUETAS_ESTADO[estadoSesion],
    });
  }

  function grupo(etiqueta, ...hijos) {
    return el("div", { class: "sesiones__grupo" }, el("p", { class: "sesiones__grupo-titulo", texto: etiqueta }), ...hijos);
  }

  function filaAbierta(item, ahora) {
    const { fila, vida } = item;
    const dispositivo = dispositivoDeFila(fila);
    const lugar = `${textoUbicacion(fila)} · ${vida.recordarme ? "Recordarme" : "Sin recordarme"}`;
    return el(
      "li",
      { class: "sesiones__item" },
      el(
        "button",
        {
          type: "button",
          class: "sesiones__fila",
          "data-foco": `fila-${fila.id}`,
          onclick: () => abrirDetalle(fila.id),
        },
        icono(tipoDispositivo(dispositivo)),
        el(
          "span",
          { class: "sesiones__datos" },
          el("span", { class: "sesiones__nombre", texto: nombreDispositivo(dispositivo) }),
          el("span", { class: "sesiones__meta", texto: lugar }),
          fila.es_actual
            ? el("span", { class: "sesiones__meta", texto: "Tu sesión actual" })
            : el("span", { class: "sesiones__meta", texto: `Último uso: ${haceCuanto(vida.ultimoUso, ahora)}` }),
          fila.es_actual ? null : el("span", { class: "sesiones__meta", texto: textoCierre(vida, ahora) })
        ),
        fila.es_actual ? null : insignia(vida.estado),
        el("span", { class: "sesiones__flecha", "aria-hidden": "true", texto: "›" })
      )
    );
  }

  // Las cerradas no abren detalle (L31): dispositivo, ciudad, cuándo y motivo.
  function filaCerrada(item, ahora) {
    const { fila } = item;
    const dispositivo = dispositivoDeFila(fila);
    return el(
      "li",
      { class: "sesiones__item sesiones__item--cerrada" },
      icono(tipoDispositivo(dispositivo)),
      el(
        "span",
        { class: "sesiones__datos" },
        el("span", { class: "sesiones__nombre", texto: nombreDispositivo(dispositivo) }),
        el("span", { class: "sesiones__meta", texto: textoUbicacion(fila) }),
        el("span", { class: "sesiones__meta", texto: `Se cerró ${fechaRelativa(fila.cerrada_en, ahora)}` }),
        el("span", { class: "sesiones__motivo", texto: fraseMotivo(fila.motivo_cierre) })
      )
    );
  }

  function plegable({ resumen, abierto, foco, alCambiar }, ...hijos) {
    const detalles = el(
      "details",
      { class: "sesiones__plegable", open: abierto },
      el("summary", { class: "sesiones__plegable-resumen", "data-foco": foco, texto: resumen }),
      ...hijos
    );
    detalles.addEventListener("toggle", () => alCambiar(detalles.open));
    return detalles;
  }

  // Al redibujar se conserva el foco: el refresco de cada minuto no debe
  // sacar al teclado del botón donde estaba.
  function conFocoConservado(contenedor, dibujar) {
    const activo = document.activeElement;
    const foco = activo && contenedor.contains(activo) ? activo.dataset.foco : null;
    dibujar();
    if (!foco) return;
    const destino = contenedor.querySelector(`[data-foco="${CSS.escape(foco)}"]`);
    if (destino) destino.focus();
  }

  function dibujarLista() {
    if (estado.fallo) {
      contenido.replaceChildren(
        el("p", { class: "portal__field-note", texto: "No pudimos cargar tus sesiones." }),
        el("button", { type: "button", class: "button button--outline", onclick: () => cargar(), texto: "Reintentar" })
      );
      return;
    }
    if (estado.filas === null) return;

    const ahora = Date.now();
    const grupos = agruparSesiones(estado.filas, ahora);
    const demas = grupos.otras.length + grupos.inactivas.length;
    const nodos = [];

    if (grupos.actual) {
      nodos.push(grupo("Este dispositivo", el("ul", { class: "sesiones__lista" }, filaAbierta(grupos.actual, ahora))));
    }

    nodos.push(
      grupo(
        `Otras sesiones · ${demas}`,
        demas === 0 ? el("p", { class: "portal__field-note", texto: "No tienes otras sesiones abiertas." }) : null,
        grupos.otras.length > 0
          ? el("ul", { class: "sesiones__lista" }, ...grupos.otras.map((item) => filaAbierta(item, ahora)))
          : null,
        grupos.inactivas.length > 0
          ? plegable(
              {
                resumen: textoInactivas(grupos.inactivas.length),
                abierto: estado.inactivasAbiertas,
                foco: "inactivas",
                alCambiar: (abierto) => (estado.inactivasAbiertas = abierto),
              },
              el("ul", { class: "sesiones__lista" }, ...grupos.inactivas.map((item) => filaAbierta(item, ahora)))
            )
          : null
      )
    );

    if (demas > 0) {
      nodos.push(
        el(
          "div",
          { class: "portal__form-actions" },
          el("button", {
            type: "button",
            class: "button button--outline portal__danger-button",
            "data-foco": "cerrar-demas",
            onclick: (evento) => cerrarDemas(evento.currentTarget, demas),
            texto: "Cerrar las demás sesiones",
          })
        )
      );
    }

    if (grupos.cerradas.length > 0) {
      const visibles = grupos.cerradas.slice(0, estado.cerradasVisibles);
      nodos.push(
        plegable(
          {
            resumen: `Cerradas en los últimos 7 días · ${grupos.cerradas.length}`,
            abierto: estado.cerradasAbiertas,
            foco: "cerradas",
            alCambiar: (abierto) => (estado.cerradasAbiertas = abierto),
          },
          el("ul", { class: "sesiones__lista" }, ...visibles.map((item) => filaCerrada(item, ahora))),
          grupos.cerradas.length > visibles.length
            ? el("button", {
                type: "button",
                class: "button button--outline sesiones__mas",
                "data-foco": "mostrar-mas",
                onclick: () => {
                  estado.cerradasVisibles += CERRADAS_POR_PAGINA;
                  conFocoConservado(contenido, dibujarLista);
                },
                texto: "Mostrar más",
              })
            : null
        )
      );
    }

    contenido.replaceChildren(...nodos);
  }

  function filaDato(etiqueta, valor) {
    return el("div", { class: "sesiones__dato" }, el("dt", { texto: etiqueta }), el("dd", { texto: valor }));
  }

  function barraVida(vida, ahora) {
    const { tramos, posicionAhora } = tramosVida(vida, ahora);
    const hitos = [["Último uso", vida.ultimoUso]];
    if (vida.inactivaDesde) hitos.push(["Inactiva desde", vida.inactivaDesde]);
    hitos.push(["Se cerrará", vida.seCerrara]);
    const resumen = hitos.map(([etiqueta, fecha]) => `${etiqueta}: ${fechaRelativa(fecha, ahora)}`).join(". ");

    // Cerca de un borde la etiqueta se ancla hacia adentro: centrada, se
    // saldría de la barra y haría scrollear la página a 375 px.
    const anclaje = posicionAhora < 0.15 ? "inicio" : posicionAhora > 0.85 ? "fin" : "centro";
    const marca = el(
      "span",
      { class: "sesiones__ahora" },
      el("span", { class: `sesiones__ahora-texto sesiones__ahora-texto--${anclaje}`, texto: "Ahora" })
    );
    marca.style.insetInlineStart = `${(posicionAhora * 100).toFixed(1)}%`;

    return el(
      "div",
      { class: "sesiones__vida" },
      el(
        "div",
        { class: "sesiones__barra", role: "img", "aria-label": `Vida de esta sesión. Ahora. ${resumen}.` },
        ...tramos.map((tramo) => el("span", { class: `sesiones__tramo sesiones__tramo--${tramo.clave}`, title: tramo.etiqueta })),
        marca
      ),
      el(
        "ol",
        { class: "sesiones__hitos", "aria-hidden": "true" },
        ...hitos.map(([etiqueta, fecha]) =>
          el("li", {}, el("span", { class: "sesiones__hito-etiqueta", texto: etiqueta }), el("span", { texto: fechaRelativa(fecha, ahora) }))
        )
      )
    );
  }

  function irAContrasena(evento) {
    evento.preventDefault();
    volverALista();
    const campo = document.getElementById("contrasenaActual");
    if (!campo) return;
    campo.scrollIntoView({ block: "center" });
    campo.focus({ preventScroll: true });
  }

  function dibujarDetalle() {
    const ahora = Date.now();
    const grupos = agruparSesiones(estado.filas || [], ahora);
    const abiertas = [grupos.actual, ...grupos.otras, ...grupos.inactivas].filter(Boolean);
    const item = abiertas.find((sesion) => sesion.fila.id === estado.detalleId);
    if (!item) {
      volverALista("Esa sesión ya se cerró");
      return;
    }

    const { fila, vida } = item;
    const dispositivo = dispositivoDeFila(fila);
    let acciones;
    if (fila.es_actual) {
      acciones = el("p", { class: "portal__field-note", texto: "Para salir de este dispositivo usa «Cerrar sesión»." });
    } else {
      const ayuda = textoNoReconoces(tieneContrasena);
      acciones = el(
        "div",
        { class: "sesiones__acciones" },
        el("button", {
          type: "button",
          class: "button button--outline portal__danger-button",
          "data-foco": "cerrar-esta",
          onclick: (evento) => cerrarUna(fila.id, evento.currentTarget),
          texto: "Cerrar esta sesión",
        }),
        el(
          "p",
          { class: "portal__field-note" },
          ayuda.texto,
          ayuda.enlace ? el("a", { href: "#cuenta", onclick: irAContrasena, texto: ayuda.enlace }) : null,
          ayuda.final
        )
      );
    }

    vistaDetalle.replaceChildren(
      el("button", {
        type: "button",
        class: "sesiones__volver",
        "data-foco": "volver",
        onclick: () => volverALista(),
        texto: "← Sesiones activas",
      }),
      el("h3", { class: "sesiones__titulo", id: "tituloDetalleSesion", tabindex: "-1", texto: "Detalle de sesión" }),
      el(
        "div",
        { class: "sesiones__cabecera" },
        icono(tipoDispositivo(dispositivo)),
        el("p", { class: "sesiones__nombre", texto: nombreDispositivo(dispositivo) }),
        fila.es_actual ? el("span", { class: "sesiones__insignia", texto: "Tu sesión actual" }) : insignia(vida.estado)
      ),
      el("h4", { class: "sesiones__subtitulo", texto: "Vida de esta sesión" }),
      barraVida(vida, ahora),
      el("p", {
        class: "portal__field-note",
        texto: "Si este dispositivo se vuelve a usar antes, pasa a activa y la cuenta empieza de nuevo.",
      }),
      el(
        "dl",
        { class: "sesiones__datos-detalle" },
        filaDato("Último uso", fila.es_actual ? "Ahora" : haceCuanto(vida.ultimoUso, ahora)),
        filaDato("Inicio de sesión", fechaCompleta(vida.iniciadaEn)),
        filaDato("Ubicación aproximada", textoUbicacion(fila)),
        filaDato("Recordarme", textoRecordarme(vida.recordarme)),
        filaDato("Navegador", detalleNavegador(dispositivo))
      ),
      acciones
    );
  }

  function abrirDetalle(id) {
    estado.detalleId = id;
    aviso.hidden = true;
    aviso.textContent = "";
    vistaLista.hidden = true;
    vistaDetalle.hidden = false;
    dibujarDetalle();
    const encabezado = document.getElementById("tituloDetalleSesion");
    if (encabezado) encabezado.focus();
  }

  function volverALista(mensaje) {
    const anterior = estado.detalleId;
    estado.detalleId = null;
    vistaDetalle.hidden = true;
    vistaDetalle.replaceChildren();
    vistaLista.hidden = false;
    dibujarLista();
    aviso.textContent = mensaje || "";
    aviso.hidden = !mensaje;

    const fila = !mensaje && anterior ? contenido.querySelector(`[data-foco="${CSS.escape(`fila-${anterior}`)}"]`) : null;
    if (fila) fila.focus();
    else if (titulo) titulo.focus();
  }

  function dibujar() {
    if (estado.detalleId) conFocoConservado(vistaDetalle, dibujarDetalle);
    else conFocoConservado(contenido, dibujarLista);
  }

  /*
    Un fallo con una lista ya dibujada no la borra: el refresco siguiente
    vuelve a intentar sin mostrar error (L33). Sólo sin lista se ofrece
    «Reintentar».
  */
  async function cargar() {
    // Una carga en curso pudo salir antes de un cierre: se repite al terminar
    // para no dibujar como abierta la sesión que se acaba de cerrar.
    if (estado.cargando) {
      estado.recargar = true;
      return;
    }
    estado.cargando = true;
    estado.recargar = false;
    try {
      const { data, error } = await supabaseClient.rpc("sesiones_listar");
      if (error || !Array.isArray(data)) throw error || new Error("sesiones_listar sin filas");
      estado.filas = data;
      estado.fallo = false;
    } catch (error) {
      console.error("[sesiones]", { contexto: "listar", error });
      if (estado.filas === null) estado.fallo = true;
    } finally {
      estado.cargando = false;
    }
    if (estado.recargar) return cargar();
    dibujar();
  }

  // «Cerrar esta sesión» no pide confirmación (L30).
  async function cerrarUna(id, boton) {
    establecerBotonOcupado(boton, true);
    let cerrada = false;
    try {
      const { data, error } = await supabaseClient.rpc("sesion_cerrar", { p_id: id });
      cerrada = !error && data === true;
    } catch {
      // Se avisa abajo.
    }
    establecerBotonOcupado(boton, false);

    if (cerrada) {
      estado.detalleId = null;
      volverALista();
      mostrarToast("Cerramos esa sesión.", "success");
    } else {
      mostrarToast("No pudimos cerrar esa sesión. Intenta de nuevo.", "error");
    }
    await cargar();
  }

  async function cerrarDemas(boton, cantidad) {
    const confirmado = await confirmarConTexto({
      titulo: "¿Cerrar las demás sesiones?",
      mensaje: `Se ${cantidad === 1 ? "cerrará 1 sesión" : `cerrarán ${cantidad} sesiones`} en otros dispositivos. Esta sesión sigue abierta.`,
      etiquetaConfirmar: "Cerrar las demás",
    });
    if (!confirmado) return;

    establecerBotonOcupado(boton, true);
    const resultado = await cerrarLasDemasSesiones();
    establecerBotonOcupado(boton, false);
    if (resultado.ok) mostrarToast("Cerramos tus otras sesiones.", "success");
    else mostrarToast("No pudimos cerrar tus otras sesiones. Intenta de nuevo.", "error");
    await cargar();
  }

  function seVe() {
    return document.visibilityState === "visible" && !(seccion && seccion.hidden);
  }

  setInterval(() => {
    if (seVe()) cargar();
  }, SESIONES_REFRESCO_MS);
  document.addEventListener("visibilitychange", () => {
    if (seVe()) cargar();
  });
  // El portal muestra la sección en su propio oyente de hashchange; se mira
  // después de que corra.
  window.addEventListener("hashchange", () => {
    setTimeout(() => {
      if (seVe()) cargar();
    }, 0);
  });
  // El cambio de contraseña crea una sesión nueva y cierra las demás (L30).
  document.addEventListener("sesiones:cambiaron", () => cargar());

  cargar();
}
