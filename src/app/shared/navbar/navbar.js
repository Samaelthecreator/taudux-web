/*
  Navbar compartido por todas las páginas. Depende de auth.service.js y debe
  cargarse después de ese servicio.
*/

/*
  La jerarquía de 2 niveles vive en el campo `hijos`. Una entrada con `hijos`
  es una cabecera de grupo pura (sin `href`/`habilitado` propios): al
  renderizar se convierte en un acordeón que despliega sus hijos in-place
  dentro del propio panel desplegable, nunca en una navegación a una página
  índice (ver crearAcordeonMenu).
*/
/*
  El panel de administración del extractor encabeza esta lista, sólo para
  admin. Historia: estuvo aquí del 2026-08-20 al 2026-09-24; ese día se sacó
  a una píldora "⚙ Administración" en la página de transacciones, porque
  administra el extractor y no el sitio; el 2026-10-01 volvió al menú a pedido,
  para llegar desde cualquier página, y la píldora se retiró. Desde el
  2026-10-02 lleva a Usuarios, la primera sección del menú lateral de
  Administración (Usuarios, Extractor, QR), y no al extractor directo. Su
  lugar lo fija tests/navbar-jerarquia.test.js.
*/
const ENLACES_NAVEGACION_BASE = [
  {
    texto: "Administración",
    href: "/app/features/admin/usuarios.html",
    habilitado: true,
    soloAdmin: true,
  },
  {
    /*
      `soloSesion` porque el portal es lo único del menú que exige sesión
      (`requerirSesion()` en portal.js). Sin esto la entrada se ofrecía a
      cualquiera y convivía con el "Acceder" del pie del mismo panel: dos
      cosas que se contradicen, y un clic que rebotaba al login.
    */
    texto: "Mi cuenta",
    href: "/app/features/portal/",
    habilitado: true,
    soloSesion: true,
    // Un clic simple abre la capa «Configuración» (S14); el href queda para
    // Ctrl+clic y «abrir en otra pestaña».
    alHacerClick: abrirCapaDesdeMenu,
  },
  {
    texto: "Academy",
    hijos: [
      { texto: "Cursos", href: "/app/features/courses/cursos.html", habilitado: true },
      // El visor de presentaciones: cada una es un deck HTML autocontenido.
      { texto: "Slides", href: "/app/features/slides/", habilitado: true },
      // Ya existía como marcador de posición; ahora la sección existe.
      { texto: "Notas", href: "/app/features/notas/", habilitado: true },
      // Va dentro de Academy y no en Tools: es para practicar lo que se
      // estudia, no una utilidad suelta. La carpeta conserva el nombre
      // interno `practica`; sólo lo público se llama Código.
      { texto: "Código", href: "/app/features/codigo/", habilitado: true },
    ],
  },
  { texto: "Noticias", habilitado: false },
  {
    texto: "Tools",
    hijos: [
      {
        texto: "Transacciones financieras",
        href: "/app/features/transactions/",
        habilitado: true,
      },
      {
        // Para todos y sin `soloSesion`: sin sesión, la página explica por qué
        // pide una cuenta y ofrece acceder; no rebota al login.
        texto: "Generador de QR",
        href: "/app/features/qr/",
        habilitado: true,
      },
      {
        // Deshabilitado y sólo para admin: `habilitado: false` lo pinta en gris,
        // `soloAdmin` decide quién llega a verlo siquiera.
        texto: "Detector de imágenes IA",
        href: "/app/features/detector/detector.html",
        habilitado: false,
        soloAdmin: true,
      },
    ],
  },
  { texto: "Proyectos", habilitado: false },
  // Entrada propia y no un hijo de Academy: es el equipo, no material de
  // estudio. Cierra el menú, justo antes del divisor de "Salir" (desde el
  // 2026-09-24; antes iba pegada a Academy, debajo de "Código").
  { texto: "Colaboradores", href: "/app/features/colaboradores/", habilitado: true },
];

/*
  Dos criterios de visibilidad, una sola pasada: `soloAdmin` y `soloSesion`.
  Los items que no corresponden desaparecen del menú en vez de pintarse en
  gris: anunciarle a alguien una sección que no le toca sólo genera preguntas.

  Ojo, esto es cosmética — la URL sigue abriendo para cualquiera porque el
  sitio es estático y no hay servidor que niegue nada. Sirve para ordenar el
  menú, NO como control de acceso: al admin lo respalda el backend, y a la
  sesión, `requerirSesion()` en la página destino.

  Los criterios viajan en un objeto y no como booleanos sueltos: en la llamada,
  `filtrar(enlaces, false, true)` no dice cuál es cuál.

  Devuelve copias: ENLACES_NAVEGACION_BASE es un módulo compartido, y filtrarlo
  en el lugar dejaría el menú recortado para el siguiente montaje.
*/
function filtrarEnlacesVisibles(enlaces, { esAdmin, haySesion }) {
  return enlaces
    .filter((enlace) => (!enlace.soloAdmin || esAdmin) && (!enlace.soloSesion || haySesion))
    .map((enlace) =>
      enlace.hijos
        ? { ...enlace, hijos: filtrarEnlacesVisibles(enlace.hijos, { esAdmin, haySesion }) }
        : enlace
    )
    // Una cabecera que se quedó sin hijos se despliega y no ofrece nada.
    .filter((enlace) => !enlace.hijos || enlace.hijos.length > 0);
}

async function salirYVolver(evento) {
  if (evento) evento.preventDefault();
  const resultado = await salirDeEstaSesion();
  if (!resultado.ok) {
    if (typeof mostrarToast === "function") mostrarToast(resultado.mensaje, "error");
    return;
  }
  window.location.href = "/";
}

/*
  La capa «Configuración» (S14, L39, L44, L49): el portal encima de la página
  actual, en un <iframe> con ?embebido=1. Lo demás es del portal, que avisa
  por postMessage cuándo cerrar y qué nombre poner en la barra.

  - Cada apertura crea un iframe nuevo y al cerrar se destruye (L49): datos
    frescos, siempre en #perfil.
  - Al abrir se agrega una entrada al historial sin cambiar la URL, y
    «Atrás» cierra la capa (L44). Moverse dentro del panel no suma entradas:
    el portal usa location.replace.
  - Mientras está abierta, lo de abajo queda `inert`: el foco no se escapa
    del panel con Tab.
  - El history.back() del cierre es asíncrono: si se reabre antes de que
    llegue su popstate, la apertura espera a ese popstate; si no, el
    retroceso consumiría la entrada nueva y cerraría la capa recién abierta.
  - Al volver con «Atrás» desde otra página (bfcache), la capa se quita y se
    consume su entrada: si no, se vería abierta y cargando.
*/
// Literal y no `${RUTAS_AUTH.portal}…`: navbar.js se evalúa también sin
// auth.service.js (tests/navbar-jerarquia.test.js), y RUTAS_AUTH sólo se
// puede leer al llamar, no al cargar.
const URL_CAPA_CONFIGURACION = "/app/features/portal/?embebido=1#perfil";

const capaConfiguracion = { raiz: null, iframe: null, origen: null, inertes: [], retrocesoPendiente: false, aperturaPendiente: null };

function debeAbrirCapaConfiguracion(evento, rutaActual) {
  if (evento.defaultPrevented || evento.button !== 0) return false;
  if (evento.ctrlKey || evento.metaKey || evento.shiftKey || evento.altKey) return false;
  // En el propio portal «Mi cuenta» navega normal: abrir el portal sobre sí
  // mismo sería un panel dentro del panel.
  return !`${rutaActual}/`.startsWith(RUTAS_AUTH.portal);
}

// Sólo del mismo origen, del iframe de la capa y de un tipo conocido.
function tipoDeMensajeDeCapa(evento, origen, ventanaDelPanel) {
  if (evento.origin !== origen || !ventanaDelPanel || evento.source !== ventanaDelPanel) return null;
  const tipo = evento.data && typeof evento.data === "object" ? evento.data.tipo : null;
  return Object.values(MENSAJES_CAPA_CONFIGURACION).includes(tipo) ? tipo : null;
}

function actualizarNombreEnMenu(nombre) {
  if (typeof nombre !== "string" || !nombre.trim()) return;
  const toggle = document.querySelector(".nav-menu__toggle--account");
  if (!toggle) return;
  toggle.setAttribute("aria-label", `Cuenta: ${nombre}`);
  const visible = toggle.querySelector(".nav-menu__nombre");
  if (visible) visible.textContent = nombre;
}

function alMensajeDeCapa(evento) {
  const tipo = tipoDeMensajeDeCapa(evento, window.location.origin, capaConfiguracion.iframe?.contentWindow);
  if (tipo === MENSAJES_CAPA_CONFIGURACION.cerrar) cerrarCapaConfiguracion();
  if (tipo === MENSAJES_CAPA_CONFIGURACION.nombre) actualizarNombreEnMenu(evento.data.nombre);
}

function alVolverConCapa() {
  cerrarCapaConfiguracion({ desdeHistorial: true });
}

function alTeclaConCapa(evento) {
  if (evento.key === "Escape") cerrarCapaConfiguracion();
}

function alResolverRetrocesoDeCapa() {
  window.removeEventListener("popstate", alResolverRetrocesoDeCapa);
  capaConfiguracion.retrocesoPendiente = false;
  const pendiente = capaConfiguracion.aperturaPendiente;
  capaConfiguracion.aperturaPendiente = null;
  if (pendiente) abrirCapaConfiguracion(pendiente.origen);
}

function abrirCapaConfiguracion(origen) {
  if (capaConfiguracion.raiz) return;
  if (capaConfiguracion.retrocesoPendiente) {
    capaConfiguracion.aperturaPendiente = { origen };
    return;
  }

  const raiz = document.createElement("div");
  raiz.className = "capa-config";
  // Clic en el fondo, no en el panel: el iframe se traga los clics de adentro.
  raiz.addEventListener("click", (evento) => {
    if (evento.target === raiz) cerrarCapaConfiguracion();
  });

  const caja = document.createElement("div");
  caja.className = "capa-config__caja";
  caja.setAttribute("role", "dialog");
  caja.setAttribute("aria-modal", "true");
  caja.setAttribute("aria-label", "Configuración");

  const cargando = document.createElement("p");
  cargando.className = "capa-config__cargando";
  cargando.textContent = "Cargando Configuración…";

  const iframe = document.createElement("iframe");
  iframe.className = "capa-config__panel";
  iframe.title = "Configuración";
  iframe.src = URL_CAPA_CONFIGURACION;
  iframe.addEventListener("load", () => {
    cargando.hidden = true;
    caja.classList.add("capa-config__caja--lista");
    iframe.focus();
  });

  caja.append(cargando, iframe);
  raiz.appendChild(caja);

  capaConfiguracion.inertes = Array.from(document.body.children).filter((hijo) => !hijo.inert);
  capaConfiguracion.inertes.forEach((hijo) => { hijo.inert = true; });
  document.body.appendChild(raiz);
  document.documentElement.classList.add("capa-config-abierta");

  capaConfiguracion.raiz = raiz;
  capaConfiguracion.iframe = iframe;
  capaConfiguracion.origen = origen || null;

  history.pushState({ capaConfiguracion: true }, "");
  window.addEventListener("popstate", alVolverConCapa);
  window.addEventListener("message", alMensajeDeCapa);
  document.addEventListener("keydown", alTeclaConCapa);
}

function cerrarCapaConfiguracion({ desdeHistorial = false } = {}) {
  const { raiz, origen, inertes } = capaConfiguracion;
  if (!raiz) return;

  window.removeEventListener("popstate", alVolverConCapa);
  window.removeEventListener("message", alMensajeDeCapa);
  document.removeEventListener("keydown", alTeclaConCapa);

  raiz.remove();
  inertes.forEach((hijo) => { hijo.inert = false; });
  document.documentElement.classList.remove("capa-config-abierta");
  Object.assign(capaConfiguracion, { raiz: null, iframe: null, origen: null, inertes: [] });

  // La entrada que agregó la capa se consume; con «Atrás» ya se consumió.
  if (!desdeHistorial) {
    capaConfiguracion.retrocesoPendiente = true;
    window.addEventListener("popstate", alResolverRetrocesoDeCapa);
    history.back();
  }
  if (origen && origen.isConnected !== false) origen.focus();
}

function abrirCapaDesdeMenu(evento) {
  if (!debeAbrirCapaConfiguracion(evento, window.location.pathname)) return;
  evento.preventDefault();
  /*
    El foco vuelve al botón de la cuenta y no al enlace: el desplegable se
    cierra con el clic, y el enlace queda oculto adentro.
  */
  abrirCapaConfiguracion(document.querySelector(".nav-menu__toggle--account") || evento.currentTarget);
}

window.addEventListener("pageshow", (evento) => {
  if (evento.persisted && capaConfiguracion.raiz) cerrarCapaConfiguracion();
});

window.addEventListener("taudux:operation-error", () => {
  queueMicrotask(() => {
    if (typeof mostrarToast !== "function") return;
    const reporteVisible = document.querySelector(
      '[role="alert"]:not([hidden]), .courses__startup-status--error:not([hidden]), .courses__data-status--error:not([hidden])'
    );
    if (!reporteVisible) {
      mostrarToast("No se pudo completar la operación. Intenta nuevamente.", "error");
    }
  });
});

function actualizarEstadoVisualNavbar() {
  const navbar = document.querySelector(".navbar");
  if (!navbar) return;

  const desplazado = window.scrollY > 60;
  navbar.classList.toggle("navbar--scrolled", desplazado);

  /*
    Misión/Visión/Valores no acompañan al hero: recién aparecen cuando el hero
    terminó de salir de pantalla, o sea cuando la segunda sección toca el tope.
    Se mide el borde inferior real del hero en cada frame en vez de comparar
    contra un umbral fijo en píxeles, para que el corte siga siendo exacto si
    el hero cambia de alto (rotar el teléfono, fuentes que cargan tarde).
    Sin hero —cualquier página que no sea el landing— la clase nunca se activa.
  */
  const hero = document.querySelector(".hero");
  const heroFueraDePantalla = Boolean(hero) && hero.getBoundingClientRect().bottom <= 0;
  navbar.classList.toggle("navbar--pasado-hero", heroFueraDePantalla);
}

/* Cache para no repetir querySelectorAll en cada evento de scroll. */
let seccionesConId = [];
let enlacesDeAncla = [];

function cachearElementosDeScroll() {
  seccionesConId = document.querySelectorAll("section[id]");
  enlacesDeAncla = document.querySelectorAll('.navbar__link[href^="#"]');
}

function actualizarEnlaceActivo() {
  if (!seccionesConId.length && !enlacesDeAncla.length) cachearElementosDeScroll();
  const secciones = seccionesConId;
  const enlaces = enlacesDeAncla;
  let seccionActual = "";

  secciones.forEach((seccion) => {
    if (window.scrollY >= seccion.offsetTop - 150) {
      seccionActual = seccion.id;
    }
  });

  enlaces.forEach((enlace) => {
    enlace.classList.toggle(
      "navbar__link--active",
      enlace.getAttribute("href") === `#${seccionActual}`
    );
  });
}

/*
  Cada desplegable registra acá su función de cierre. Al abrir uno se cierran
  los demás: en ≤760px los dos toggles conviven en una barra de 6.5rem y dos
  paneles abiertos a la vez se pisarían.
*/
const cerradoresDeDesplegables = [];

function crearDesplegable({ clase, idLista, etiqueta }) {
  const menu = document.createElement("div");
  menu.className = `nav-menu nav-menu--${clase}`;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = `nav-menu__toggle nav-menu__toggle--${clase}`;
  toggle.setAttribute("aria-haspopup", "menu");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", idLista);
  toggle.setAttribute("aria-label", etiqueta);

  const lista = document.createElement("div");
  lista.className = "nav-menu__list floating-menu";
  lista.id = idLista;

  menu.appendChild(toggle);
  menu.appendChild(lista);

  return { menu, toggle, lista };
}

function conectarDesplegable({ menu, toggle, lista }) {
  function establecerMenuAbierto(abierto) {
    menu.classList.toggle("nav-menu--open", abierto);
    toggle.setAttribute("aria-expanded", String(abierto));
  }

  const cerrar = () => establecerMenuAbierto(false);
  cerradoresDeDesplegables.push(cerrar);

  toggle.addEventListener("click", (evento) => {
    evento.stopPropagation();
    const abriendo = !menu.classList.contains("nav-menu--open");
    if (abriendo) {
      cerradoresDeDesplegables.forEach((otroCerrar) => {
        if (otroCerrar !== cerrar) otroCerrar();
      });
    }
    establecerMenuAbierto(abriendo);
  });

  document.addEventListener("click", (evento) => {
    if (!menu.contains(evento.target)) cerrar();
  });

  menu.addEventListener("keydown", (evento) => {
    if (evento.key === "Escape" && menu.classList.contains("nav-menu--open")) {
      cerrar();
      toggle.focus();
    }
  });

  /*
    Las anclas del landing no recargan la página, así que sin este cierre
    explícito el panel quedaría abierto tapando la sección recién saltada.
  */
  lista.addEventListener("click", (evento) => {
    if (evento.target.closest("a")) cerrar();
  });

  return cerrar;
}

function crearItemMenu({ texto, href, alHacerClick, destacado, habilitado = true, esHijo = false }) {
  if (!habilitado) {
    const item = document.createElement("span");
    item.className = "nav-menu__link nav-menu__link--disabled";
    if (esHijo) item.classList.add("nav-menu__link--child");
    item.setAttribute("aria-disabled", "true");
    item.textContent = texto;
    return item;
  }

  const enlace = document.createElement("a");
  enlace.href = href;
  enlace.className = "nav-menu__link floating-menu__link";
  if (destacado) enlace.classList.add("nav-menu__link--cta");
  if (esHijo) enlace.classList.add("nav-menu__link--child");
  enlace.textContent = texto;
  if (alHacerClick) enlace.addEventListener("click", alHacerClick);
  return enlace;
}

/*
  Combina el prefijo del contenedor padre (idLista del desplegable:
  "menuCuentaLista" en la cuenta) con el texto normalizado del grupo, para
  que el id del panel sea único en el documento: aria-controls lo exige.
*/
function idDePanelAcordeon(prefijoId, texto) {
  const slug = texto
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return `${prefijoId}-acordeon-${slug}`;
}

/*
  Grupo colapsable (Academy, Tools): a diferencia de crearItemMenu, el nodo
  que devuelve es un contenedor con hijos reales en el DOM, no una hoja
  aplanada. El toggle es un <button>, nunca un <a>: el listener de cierre
  global en conectarDesplegable cierra el panel entero cuando el click viene
  de un <a> (`evento.target.closest("a")`), y un botón no matchea ese
  selector, así que expandir el grupo no cierra el desplegable completo.

  `registroDeCierres` es un array local del panel que llama a esta función,
  NO el `cerradoresDeDesplegables` global de arriba — ese resuelve la
  exclusión mutua entre desplegables; este, la exclusión mutua entre Academy
  y Tools dentro de un mismo panel.
*/
function crearAcordeonMenu({ texto, hijos }, { registroDeCierres, prefijoId }) {
  const contenedor = document.createElement("div");
  contenedor.className = "nav-menu__accordion";

  const idPanel = idDePanelAcordeon(prefijoId, texto);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "nav-menu__link floating-menu__link nav-menu__accordion-toggle";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", idPanel);
  // Mismo <span> que crearItemMenu para los ítems con badge: el texto
  // suelto no se puede centrar con flex, necesita su propia caja (ver
  // .nav-menu__link-label en navbar.css).
  const etiqueta = document.createElement("span");
  etiqueta.className = "nav-menu__link-label";
  etiqueta.textContent = texto;
  toggle.appendChild(etiqueta);

  const panel = document.createElement("div");
  panel.className = "nav-menu__accordion-panel";
  panel.id = idPanel;

  const panelInterior = document.createElement("div");
  panelInterior.className = "nav-menu__accordion-panel-inner";
  hijos.forEach((hijo) => panelInterior.appendChild(crearItemMenu({ ...hijo, esHijo: true })));
  panel.appendChild(panelInterior);

  function establecerAbierto(abierto) {
    contenedor.classList.toggle("nav-menu__accordion--open", abierto);
    toggle.setAttribute("aria-expanded", String(abierto));
  }

  const cerrar = () => establecerAbierto(false);
  registroDeCierres.push(cerrar);

  // Arranca siempre cerrado; abrir este grupo cierra cualquier otro del
  // mismo registro (exclusión mutua, un solo grupo abierto a la vez).
  toggle.addEventListener("click", () => {
    const abriendo = !contenedor.classList.contains("nav-menu__accordion--open");
    if (abriendo) {
      registroDeCierres.forEach((otroCerrar) => {
        if (otroCerrar !== cerrar) otroCerrar();
      });
    }
    establecerAbierto(abriendo);
  });

  contenedor.appendChild(toggle);
  contenedor.appendChild(panel);
  return contenedor;
}

function enlaceDeSesion(session) {
  if (!session) {
    return { texto: "Acceder", href: RUTAS_AUTH.login, destacado: true };
  }
  return { texto: "Salir", href: "#", alHacerClick: salirYVolver };
}

async function nombreParaMenu(session, perfil) {
  if (!session) return null;
  const nombre = await nombreUsuario(session, perfil);
  return nombre || "Mi cuenta";
}

async function montarMenus() {
  const boton = document.getElementById("accessBtn");
  if (!boton) return;

  // #accessBtn arranca oculto por CSS (navbar.css) para no parpadear el
  // "Acceder" plano mientras se resuelve la sesión. Si algo de acá adentro
  // falla antes del replaceWith, el finally lo revela como respaldo en vez
  // de dejarlo invisible para siempre.
  try {
    const session = await obtenerSesion();
    /*
      El perfil se resuelve una sola vez y de él salen las dos cosas que el menú
      necesita: el rol (para filtrar) y el nombre. obtenerPerfil() no cachea, así
      que pedirlo por separado costaría dos consultas en cada carga de página, y
      el navbar se monta en todas.
    */
    const perfil = session ? await obtenerPerfil(session) : null;
    const enlacesNavegacion = filtrarEnlacesVisibles(ENLACES_NAVEGACION_BASE, {
      esAdmin: perfil?.rol === "admin",
      haySesion: Boolean(session),
    });

    const nombreCuenta = await nombreParaMenu(session, perfil);

    const { menu, toggle, lista } = crearDesplegable({
      clase: "account",
      idLista: "menuCuentaLista",
      etiqueta: nombreCuenta ? `Cuenta: ${nombreCuenta}` : "Cuenta",
    });
    toggle.classList.toggle("nav-menu__toggle--pulsing", !session);

    /*
      Quién inició sesión, a la vista bajo el ícono (2026-10-02). Reemplaza al
      encabezado con el nombre que abría el menú: repetirlo ahí sobraba. Va
      oculto al lector de pantalla: el aria-label del botón ya dice
      «Cuenta: <nombre>».
    */
    if (session && nombreCuenta) {
      const nombreVisible = document.createElement("span");
      nombreVisible.className = "nav-menu__nombre";
      nombreVisible.setAttribute("aria-hidden", "true");
      nombreVisible.textContent = nombreCuenta;
      toggle.appendChild(nombreVisible);
    }

    /*
      Este grupo es la navegación del sitio en todos los tamaños: desde el
      2026-10-02 no hay hamburguesa en mobile, y en desktop es la única vía de
      las páginas sin fila de enlaces (cursos, transacciones, privacidad).
    */
    const grupoNavegacion = document.createElement("div");
    grupoNavegacion.className = "nav-menu__group nav-menu__group--nav";
    // Registro propio de este grupo: la exclusión mutua entre Academy y Tools
    // no se mezcla con cerradoresDeDesplegables (otro concern).
    const registroDeCierresCuenta = [];
    enlacesNavegacion.forEach((enlace) => {
      if (enlace.hijos && enlace.hijos.length) {
        grupoNavegacion.appendChild(
          crearAcordeonMenu(enlace, { registroDeCierres: registroDeCierresCuenta, prefijoId: lista.id })
        );
      } else {
        grupoNavegacion.appendChild(crearItemMenu(enlace));
      }
    });
    lista.appendChild(grupoNavegacion);

    const divisor = document.createElement("hr");
    divisor.className = "nav-menu__divider";
    lista.appendChild(divisor);
    lista.appendChild(crearItemMenu(enlaceDeSesion(session)));

    boton.replaceWith(menu);
    conectarDesplegable({ menu, toggle, lista });
  } finally {
    if (boton.isConnected) boton.style.visibility = "visible";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  cachearElementosDeScroll();
  actualizarEstadoVisualNavbar();
  actualizarEnlaceActivo();
  // Dentro de la capa la barra no se ve (portal.css): la de arriba ya está.
  // Montarla costaría una consulta del perfil en cada apertura.
  if (!enCapaDeConfiguracion()) montarMenus();
});

/* Throttle con requestAnimationFrame: como mucho una actualización por frame,
   aunque lleguen varios eventos de scroll. */
let actualizacionPendiente = false;

window.addEventListener(
  "scroll",
  () => {
    if (actualizacionPendiente) return;
    actualizacionPendiente = true;
    requestAnimationFrame(() => {
      actualizarEstadoVisualNavbar();
      actualizarEnlaceActivo();
      actualizacionPendiente = false;
    });
  },
  { passive: true }
);
