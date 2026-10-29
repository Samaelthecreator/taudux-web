/*
  «Sesiones activas» en «Acceso y seguridad» (T5 de sesiones-activas): la lista
  de sesiones, en una tabla (L62). Tocar una fila no hace nada (L61): cada
  sesión de otro dispositivo se cierra con su «⋯», que pide confirmación. Los
  estados, plazos y textos salen de sesiones.nucleo.js; acá sólo se pide la
  lista, se dibuja y se cierra.

  Todo se escribe con textContent: la ciudad viene de Vercel y el navegador del
  user agent de otro dispositivo, así que nada de eso se trata como HTML.

  La misma lista llena el resumen «Dispositivos con acceso a tu cuenta» de
  «Acceso y seguridad» (T9, S15). Se pide al abrir el portal, tras cada cierre
  y cada ~60 s con la pestaña visible y el resumen o la lista a la vista (L30).

  Depende de sesiones.nucleo.js, sesiones.service.js (dispositivoDesde),
  auth.service.js, auth-identidades.js, auth-ui.js, toast.js y confirm-dialog.js.
*/

const SESIONES_REFRESCO_MS = 60 * 1000;
const SVG_NS = "http://www.w3.org/2000/svg";

function configurarSesionesActivas(session) {
  const raiz = document.getElementById("sesiones");
  const contenido = document.getElementById("sesionesContenido");
  const titulo = document.getElementById("tituloSesiones");
  if (!raiz || !contenido) return;

  const seccion = raiz.closest(".portal__section");
  const resumen = document.getElementById("dispositivosResumen");
  const totalResumen = document.getElementById("dispositivosTotal");
  const seccionResumen = resumen ? resumen.closest(".portal__section") : null;
  const tieneContrasena = puedeUsarContrasena(session.user);
  const estado = {
    filas: null,
    fallo: false,
    cargando: false,
    recargar: false,
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

  // `tipo`: el de tipoDispositivo («movil») o el de claseDispositivo.
  function svgDispositivo(tipo) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "sesiones__icono");
    let formas;
    if (tipo === "movil" || tipo === "telefono") {
      formas = [["rect", { x: 7, y: 2, width: 10, height: 20, rx: 2 }], ["path", { d: "M11 18h2" }]];
    } else if (tipo === "tableta") {
      formas = [["rect", { x: 4, y: 2, width: 16, height: 20, rx: 2 }], ["path", { d: "M11 18h2" }]];
    } else {
      formas = [["rect", { x: 2, y: 4, width: 20, height: 13, rx: 2 }], ["path", { d: "M8 21h8M12 17v4" }]];
    }
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

  /*
    Una fila de la tabla (L62). Los hijos de <td> son block o inline, nunca
    cambian el display de la celda (invariante de layout). La insignia de
    estado va junto al nombre; «Se cerrará …», bajo «Actualizado».
  */
  function filaAbierta(item, ahora) {
    const { fila, vida } = item;
    const nombre = nombreDispositivo(dispositivoDeFila(fila));
    return el(
      "tr",
      {},
      el(
        "td",
        {},
        el(
          "div",
          { class: "sesiones__dispositivo" },
          el("span", { class: "sesiones__nombre", texto: nombre }),
          fila.es_actual ? el("span", { class: "sesiones__insignia sesiones__insignia--actual", texto: "Actual" }) : insignia(vida.estado)
        )
      ),
      el("td", { texto: textoUbicacion(fila) }),
      el("td", { class: "sesiones__fecha", texto: fechaCompleta(vida.iniciadaEn) }),
      el(
        "td",
        { class: "sesiones__fecha" },
        el("div", { texto: fechaCompleta(vida.ultimoUso) }),
        fila.es_actual ? null : el("div", { class: "sesiones__meta", texto: textoCierre(vida, ahora) })
      ),
      el(
        "td",
        { class: "sesiones__accion" },
        // La actual se cierra con «Cerrar sesión» de «Acceso y seguridad».
        fila.es_actual
          ? null
          : el("button", {
              type: "button",
              class: "sesiones__mas-opciones",
              "aria-label": `Cerrar la sesión de ${nombre}`,
              "data-foco": `cerrar-${fila.id}`,
              onclick: (evento) => cerrarUna(fila.id, evento.currentTarget),
              texto: "⋯",
            })
      )
    );
  }

  // En un teléfono la tabla se desliza dentro de su caja: la página no
  // scrollea de lado (L62). Abiertas y cerradas usan la misma (L66).
  function tabla(columnas, filas, { conAccion = false } = {}) {
    return el(
      "div",
      { class: "sesiones__tabla-envoltorio" },
      el(
        "table",
        { class: "sesiones__tabla" },
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            ...columnas.map((texto) => el("th", { scope: "col", texto })),
            conAccion ? el("th", { scope: "col", class: "sesiones__accion", "aria-label": "Acciones" }) : null
          )
        ),
        el("tbody", {}, ...filas)
      )
    );
  }

  function tablaSesiones(items, ahora) {
    return tabla(
      ["Dispositivo", "Ubicación", "Creado", "Actualizado"],
      items.map((item) => filaAbierta(item, ahora)),
      { conAccion: true }
    );
  }

  // Las cerradas sólo dicen dispositivo, ciudad, cuándo y motivo (L31), sin
  // control: tocarlas no hace nada.
  function filaCerrada(item) {
    const { fila } = item;
    return el(
      "tr",
      {},
      el(
        "td",
        {},
        el(
          "div",
          { class: "sesiones__dispositivo" },
          el("span", { class: "sesiones__nombre", texto: nombreDispositivo(dispositivoDeFila(fila)) })
        )
      ),
      el("td", { texto: textoUbicacion(fila) }),
      el("td", { class: "sesiones__fecha", texto: fechaCompleta(fila.cerrada_en) }),
      el("td", { texto: fraseMotivo(fila.motivo_cierre) })
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

  /*
    «Dispositivos con acceso a tu cuenta» (S15, L59): una fila por tipo, antes
    de «Administrar todos los dispositivos», que ya está en el HTML. Las filas
    del resumen llevan data-resumen para reemplazarlas en cada carga.
  */
  function dibujarResumen() {
    if (!resumen) return;
    let filas;
    let total = null;
    if (estado.filas === null) {
      if (!estado.fallo) return;
      filas = [
        el("p", {
          class: "portal__fila portal__fila--fija portal__fila-desc",
          "data-resumen": true,
          texto: "No pudimos cargar tus dispositivos.",
        }),
      ];
    } else {
      const ahora = Date.now();
      const datos = resumirPorTipo(estado.filas, ahora, dispositivoDeFila);
      total = datos.total;
      filas = datos.grupos.map((grupo) =>
        el(
          "a",
          { class: "portal__fila", href: "#sesiones", "data-resumen": true, "data-foco": `resumen-${grupo.clase}` },
          el("span", { class: "portal__fila-icono", "aria-hidden": "true" }, svgDispositivo(grupo.clase)),
          el(
            "span",
            { class: "portal__fila-datos" },
            el("span", { class: "portal__fila-titulo", texto: grupo.titulo }),
            grupo.detalle ? el("span", { class: "portal__fila-desc", texto: grupo.detalle }) : null
          ),
          el("span", { class: "portal__fila-flecha", "aria-hidden": "true", texto: "›" })
        )
      );
    }
    resumen.querySelectorAll("[data-resumen]").forEach((nodo) => nodo.remove());
    const administrar = resumen.querySelector('a[href="#sesiones"]:not([data-resumen])');
    for (const nodo of filas) resumen.insertBefore(nodo, administrar);
    if (totalResumen) {
      totalResumen.hidden = total === null;
      totalResumen.textContent = total === null ? "" : String(total);
    }
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

    // Una sola tabla con la actual primero, marcada «Actual» (L62).
    const visibles = [grupos.actual, ...grupos.otras].filter(Boolean);
    const abiertas = visibles.length + grupos.inactivas.length;
    nodos.push(
      grupo(
        `Sesiones abiertas · ${abiertas}`,
        visibles.length > 0 ? tablaSesiones(visibles, ahora) : null,
        demas === 0 ? el("p", { class: "portal__field-note", texto: "No tienes otras sesiones abiertas." }) : null,
        grupos.inactivas.length > 0
          ? plegable(
              {
                resumen: textoInactivas(grupos.inactivas.length),
                abierto: estado.inactivasAbiertas,
                foco: "inactivas",
                alCambiar: (abierto) => (estado.inactivasAbiertas = abierto),
              },
              tablaSesiones(grupos.inactivas, ahora)
            )
          : null
      )
    );

    if (demas > 0) {
      nodos.push(
        el(
          "div",
          { class: "portal__form-actions sesiones__acciones" },
          el("button", {
            type: "button",
            class: "sesiones__cerrar-demas",
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
          tabla(["Dispositivo", "Ubicación", "Cerrada", "Motivo"], visibles.map((item) => filaCerrada(item))),
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

  function dibujar() {
    if (resumen) conFocoConservado(resumen, dibujarResumen);
    conFocoConservado(contenido, dibujarLista);
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

  // «⋯» pide confirmación antes de cerrar (L62; antes no la pedía, L30).
  async function cerrarUna(id, boton) {
    const confirmado = await confirmarConTexto({
      titulo: "¿Cerrar esta sesión?",
      mensaje: "Ese dispositivo perderá acceso a tu cuenta.",
      etiquetaConfirmar: "Cerrar sesión",
    });
    if (!confirmado) return;

    establecerBotonOcupado(boton, true);
    let cerrada = false;
    try {
      const { data, error } = await supabaseClient.rpc("sesion_cerrar", { p_id: id });
      cerrada = !error && data === true;
    } catch {
      // Se avisa abajo.
    }
    establecerBotonOcupado(boton, false);

    if (cerrada) mostrarToast("Cerramos esa sesión.", "success");
    else mostrarToast("No pudimos cerrar esa sesión. Intenta de nuevo.", "error");
    await cargar();
    // La fila cerrada desaparece con su botón: el foco vuelve al título.
    if (cerrada && titulo) titulo.focus();
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
    const visible = document.visibilityState === "visible";
    const conLista = !(seccion && seccion.hidden);
    const conResumen = Boolean(seccionResumen) && !seccionResumen.hidden;
    return visible && (conLista || conResumen);
  }

  const nota = document.getElementById("notaNoReconoces");
  if (nota) nota.textContent = textoNoReconocesResumen(tieneContrasena);

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
