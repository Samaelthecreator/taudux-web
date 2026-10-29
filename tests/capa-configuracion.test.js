/*
  La capa «Configuración» (T7b, S14, L39, L44, L49): «Mi cuenta» abre el
  portal encima de la página actual, en un <iframe> con ?embebido=1.

  Bloque A — auth.service.js: quién navega cuando el portal está en la capa.
  Bloque B — navbar.js: cuándo se abre la capa, qué mensajes acepta y cómo
  se abre y se cierra (DOM falso mínimo).
  Bloque C — portal.secciones.js: qué enlaces salen del panel.
  Bloque D — portal.js: las salidas y la ✕ pasan por la ventana de arriba.
*/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = (relativo) => fs.readFileSync(path.join(ROOT, relativo), "utf8");
const AUTH_SERVICE_SOURCE = read("src/app/core/auth/auth.service.js");
const NAVBAR_SOURCE = read("src/app/shared/navbar/navbar.js");
const PORTAL_JS_SOURCE = read("src/app/features/portal/portal.js");

const { enlaceSaleDelPanel } = require("../src/app/features/portal/portal.secciones.js");

const ORIGEN = "https://taudux.com";

function ubicacion(ruta) {
  const url = new URL(ruta, ORIGEN);
  return {
    origin: ORIGEN,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    href: url.href,
    asignadas: [],
    assign(destino) { this.asignadas.push(destino); },
  };
}

/* Una ventana de arriba y, opcionalmente, el iframe de la capa adentro. */
function crearContextoAuth({ rutaPropia, rutaArriba, sesion = null, oauth } = {}) {
  const arriba = { location: ubicacion(rutaArriba || rutaPropia) };
  arriba.top = arriba;
  const propia = rutaArriba ? { location: ubicacion(rutaPropia), top: arriba } : arriba;
  const llamadasOauth = [];
  const context = {
    window: propia,
    URL,
    URLSearchParams,
    supabaseClient: {
      auth: {
        async getSession() { return { data: { session: sesion }, error: null }; },
        async signInWithOAuth(args) {
          llamadasOauth.push(args);
          return oauth ? oauth(args) : { data: { url: "https://accounts.google.com/o/x" }, error: null };
        },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(AUTH_SERVICE_SOURCE, context);
  return { context, arriba, propia, llamadasOauth };
}

/* Bloque A */

test("enCapaDeConfiguracion: sólo dentro de un iframe y con ?embebido=1", () => {
  const enCapa = crearContextoAuth({ rutaPropia: "/app/features/portal/?embebido=1#perfil", rutaArriba: "/app/features/courses/cursos.html" });
  assert.equal(enCapa.context.enCapaDeConfiguracion(), true);

  // Abierto como página aunque alguien copie la URL con el parámetro.
  const suelto = crearContextoAuth({ rutaPropia: "/app/features/portal/?embebido=1" });
  assert.equal(suelto.context.enCapaDeConfiguracion(), false);

  // Otro iframe del sitio (los slides) no es la capa.
  const slides = crearContextoAuth({ rutaPropia: "/content/slides/x/", rutaArriba: "/app/features/slides/" });
  assert.equal(slides.context.enCapaDeConfiguracion(), false);
});

test("requerirSesion en la capa sin sesión: el login se abre arriba y regresa a la página de abajo (L49)", async () => {
  const { context, arriba, propia } = crearContextoAuth({
    rutaPropia: "/app/features/portal/?embebido=1#perfil",
    rutaArriba: "/app/features/courses/cursos.html?categoria=2",
  });
  const resultado = await context.requerirSesion();
  assert.equal(resultado, null);
  assert.equal(
    arriba.location.href,
    `/app/features/auth/login/?next=${encodeURIComponent("/app/features/courses/cursos.html?categoria=2")}`,
  );
  assert.equal(propia.location.href, `${ORIGEN}/app/features/portal/?embebido=1#perfil`,
    "el iframe no navega: el login no se deja enmarcar");
});

test("requerirSesion fuera de la capa sigue como antes: regresa a la misma página", async () => {
  const { context, arriba } = crearContextoAuth({ rutaPropia: "/app/features/portal/#cuenta" });
  assert.equal(await context.requerirSesion(), null);
  assert.equal(arriba.location.href, `/app/features/auth/login/?next=${encodeURIComponent("/app/features/portal/#cuenta")}`);
});

test("requerirSesion con sesión no navega ninguna ventana", async () => {
  const sesion = { user: { id: "u1" } };
  const { context, arriba } = crearContextoAuth({ rutaPropia: "/app/features/portal/?embebido=1", rutaArriba: "/", sesion });
  assert.equal(await context.requerirSesion(), sesion);
  assert.equal(arriba.location.href, `${ORIGEN}/`);
});

test("ventanaQueNavega: la de arriba en la capa, la propia fuera de ella", () => {
  const enCapa = crearContextoAuth({ rutaPropia: "/app/features/portal/?embebido=1", rutaArriba: "/" });
  assert.equal(enCapa.context.ventanaQueNavega(), enCapa.arriba);
  const pagina = crearContextoAuth({ rutaPropia: "/app/features/portal/" });
  assert.equal(pagina.context.ventanaQueNavega(), pagina.propia);
});

test("reautenticarConGoogle en la capa: Google se abre en la ventana de arriba (Google no se deja enmarcar)", async () => {
  const { context, arriba, llamadasOauth } = crearContextoAuth({ rutaPropia: "/app/features/portal/?embebido=1", rutaArriba: "/" });
  const resultado = await context.reautenticarConGoogle();
  assert.equal(resultado.ok, true);
  assert.equal(llamadasOauth[0].options.skipBrowserRedirect, true);
  assert.equal(llamadasOauth[0].options.redirectTo, `${ORIGEN}/app/features/portal/`);
  assert.deepEqual(arriba.location.asignadas, ["https://accounts.google.com/o/x"]);
});

test("reautenticarConGoogle fuera de la capa sigue navegando la misma pestaña, sin skipBrowserRedirect", async () => {
  const { context, arriba, llamadasOauth } = crearContextoAuth({ rutaPropia: "/app/features/portal/" });
  assert.equal((await context.reautenticarConGoogle()).ok, true);
  assert.equal(llamadasOauth[0].options.skipBrowserRedirect, undefined);
  assert.deepEqual(arriba.location.asignadas, []);
});

test("reautenticarConGoogle en la capa con error del proveedor no navega", async () => {
  const { context, arriba } = crearContextoAuth({
    rutaPropia: "/app/features/portal/?embebido=1",
    rutaArriba: "/",
    oauth: () => ({ data: null, error: { code: "provider_disabled" } }),
  });
  const resultado = await context.reautenticarConGoogle();
  assert.equal(resultado.ok, false);
  assert.deepEqual(arriba.location.asignadas, []);
});

/* Bloque B — navbar.js con un DOM falso mínimo. */

class Nodo {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.className = "";
    this.hidden = false;
    this.style = {};
    const clases = new Set();
    this.classList = {
      add: (...n) => n.forEach((c) => clases.add(c)),
      remove: (...n) => n.forEach((c) => clases.delete(c)),
      contains: (c) => clases.has(c),
      toggle: (c, f) => (f ?? !clases.has(c) ? clases.add(c) : clases.delete(c)),
    };
    if (this.tagName === "IFRAME") this.contentWindow = { soy: "iframe" };
    this.enfocado = 0;
  }
  appendChild(hijo) { this.children.push(hijo); hijo.parentNode = this; return hijo; }
  append(...hijos) { hijos.forEach((h) => this.appendChild(h)); }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((h) => h !== this);
    this.parentNode = null;
  }
  get isConnected() { return Boolean(this.parentNode); }
  setAttribute(n, v) { this.attributes[n] = String(v); }
  removeAttribute(n) { delete this.attributes[n]; }
  hasAttribute(n) { return n in this.attributes; }
  addEventListener(tipo, fn) { (this.listeners[tipo] ||= []).push(fn); }
  removeEventListener(tipo, fn) { this.listeners[tipo] = (this.listeners[tipo] || []).filter((f) => f !== fn); }
  focus() { this.enfocado += 1; }
  contains(otro) { return otro === this || this.children.some((h) => h.contains && h.contains(otro)); }
}

function buscar(nodo, predicado) {
  if (predicado(nodo)) return nodo;
  for (const hijo of nodo.children || []) {
    const hallado = buscar(hijo, predicado);
    if (hallado) return hallado;
  }
  return null;
}

function cargarNavbar(ruta = "/app/features/courses/cursos.html") {
  const body = new Nodo("body");
  const pagina = body.appendChild(new Nodo("main"));
  const documentElement = new Nodo("html");
  const historial = { empujadas: 0, atras: 0 };
  const ventanaListeners = {};
  const window = {
    location: ubicacion(ruta),
    scrollY: 0,
    addEventListener(tipo, fn) { (ventanaListeners[tipo] ||= []).push(fn); },
    removeEventListener(tipo, fn) { ventanaListeners[tipo] = (ventanaListeners[tipo] || []).filter((f) => f !== fn); },
  };
  window.top = window;
  const document = {
    body,
    documentElement,
    addEventListener: body.addEventListener.bind(body),
    removeEventListener: body.removeEventListener.bind(body),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: (t) => new Nodo(t),
  };
  const context = {
    window,
    document,
    history: {
      pushState() { historial.empujadas += 1; },
      back() { historial.atras += 1; },
    },
    URL,
    URLSearchParams,
    queueMicrotask,
  };
  vm.createContext(context);
  vm.runInContext(
    `${AUTH_SERVICE_SOURCE}\n${NAVBAR_SOURCE}
    this.debeAbrirCapaConfiguracion = debeAbrirCapaConfiguracion;
    this.tipoDeMensajeDeCapa = tipoDeMensajeDeCapa;
    this.abrirCapaConfiguracion = abrirCapaConfiguracion;
    this.cerrarCapaConfiguracion = cerrarCapaConfiguracion;
    this.URL_CAPA_CONFIGURACION = URL_CAPA_CONFIGURACION;
    this.ENLACES_NAVEGACION_BASE = ENLACES_NAVEGACION_BASE;
    this.crearItemMenu = crearItemMenu;
    this.MENSAJES_CAPA_CONFIGURACION = MENSAJES_CAPA_CONFIGURACION;`,
    context,
  );
  const emitir = (tipo, evento) => (ventanaListeners[tipo] || []).slice().forEach((fn) => fn(evento));
  const capa = () => buscar(body, (n) => n.tagName === "IFRAME");
  return { context, body, pagina, documentElement, historial, emitir, capa };
}

const clic = (extra = {}) => ({ button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...extra });

test("debeAbrirCapaConfiguracion: clic simple fuera del portal abre la capa", () => {
  const { context } = cargarNavbar();
  assert.equal(context.debeAbrirCapaConfiguracion(clic(), "/app/features/courses/cursos.html"), true);
});

test("debeAbrirCapaConfiguracion: con modificador o botón central se conserva el enlace normal", () => {
  const { context } = cargarNavbar();
  const ruta = "/";
  assert.equal(context.debeAbrirCapaConfiguracion(clic({ ctrlKey: true }), ruta), false);
  assert.equal(context.debeAbrirCapaConfiguracion(clic({ metaKey: true }), ruta), false);
  assert.equal(context.debeAbrirCapaConfiguracion(clic({ shiftKey: true }), ruta), false);
  assert.equal(context.debeAbrirCapaConfiguracion(clic({ altKey: true }), ruta), false);
  assert.equal(context.debeAbrirCapaConfiguracion(clic({ button: 1 }), ruta), false);
  assert.equal(context.debeAbrirCapaConfiguracion(clic({ defaultPrevented: true }), ruta), false);
});

test("debeAbrirCapaConfiguracion: en el propio portal «Mi cuenta» navega normal", () => {
  const { context } = cargarNavbar();
  assert.equal(context.debeAbrirCapaConfiguracion(clic(), "/app/features/portal/"), false);
  assert.equal(context.debeAbrirCapaConfiguracion(clic(), "/app/features/portal"), false);
});

test("tipoDeMensajeDeCapa: sólo acepta mensajes del mismo origen, del iframe de la capa y de tipo conocido", () => {
  const { context } = cargarNavbar();
  const panel = { soy: "iframe" };
  const { cerrar, nombre } = context.MENSAJES_CAPA_CONFIGURACION;
  const valido = { origin: ORIGEN, source: panel, data: { tipo: cerrar } };
  assert.equal(context.tipoDeMensajeDeCapa(valido, ORIGEN, panel), cerrar);
  assert.equal(context.tipoDeMensajeDeCapa({ ...valido, data: { tipo: nombre, nombre: "Ana" } }, ORIGEN, panel), nombre);
  assert.equal(context.tipoDeMensajeDeCapa({ ...valido, origin: "https://otro.com" }, ORIGEN, panel), null);
  assert.equal(context.tipoDeMensajeDeCapa({ ...valido, source: { otra: true } }, ORIGEN, panel), null);
  assert.equal(context.tipoDeMensajeDeCapa({ ...valido, data: { tipo: "otra-cosa" } }, ORIGEN, panel), null);
  assert.equal(context.tipoDeMensajeDeCapa({ ...valido, data: "taudux:cerrar-configuracion" }, ORIGEN, panel), null);
  assert.equal(context.tipoDeMensajeDeCapa({ ...valido, data: null }, ORIGEN, panel), null);
});

test("abrir la capa: un iframe del portal embebido en #perfil, una entrada de historial y la página de abajo inerte", () => {
  const { context, body, pagina, documentElement, historial, capa } = cargarNavbar();
  assert.equal(context.URL_CAPA_CONFIGURACION, "/app/features/portal/?embebido=1#perfil");
  context.abrirCapaConfiguracion(null);
  const iframe = capa();
  assert.ok(iframe, "hay un iframe");
  assert.equal(iframe.src, "/app/features/portal/?embebido=1#perfil");
  assert.equal(iframe.title, "Configuración");
  assert.equal(historial.empujadas, 1);
  assert.equal(documentElement.classList.contains("capa-config-abierta"), true);
  assert.equal(pagina.inert, true);
  assert.equal(body.children.length, 2);

  // Abrirla otra vez con la capa ya abierta no apila otra.
  context.abrirCapaConfiguracion(null);
  assert.equal(body.children.length, 2);
  assert.equal(historial.empujadas, 1);
});

test("cerrar con ✕/Esc/clic fuera: quita la capa, devuelve la entrada de historial y el foco", () => {
  const { context, body, pagina, documentElement, historial } = cargarNavbar();
  const origen = pagina.appendChild(new Nodo("button"));
  context.abrirCapaConfiguracion(origen);
  context.cerrarCapaConfiguracion();
  assert.equal(body.children.length, 1);
  assert.equal(historial.atras, 1, "la entrada que agregó la capa se consume");
  assert.equal(documentElement.classList.contains("capa-config-abierta"), false);
  assert.equal(pagina.inert, false);
  assert.equal(origen.enfocado, 1);
});

test("«Atrás» del navegador cierra la capa sin volver a retroceder (L44)", () => {
  const { context, body, historial, emitir } = cargarNavbar();
  context.abrirCapaConfiguracion(null);
  emitir("popstate", {});
  assert.equal(body.children.length, 1);
  assert.equal(historial.atras, 0);
});

test("reabrir antes de que llegue el «Atrás» del cierre: la capa nueva espera y no se cierra sola (L51 a)", () => {
  const { context, body, historial, emitir, capa } = cargarNavbar();
  context.abrirCapaConfiguracion(null);
  context.cerrarCapaConfiguracion();
  context.abrirCapaConfiguracion(null);
  assert.equal(capa(), null, "con el retroceso en camino todavía no abre");
  assert.equal(historial.empujadas, 1);

  // Llega el popstate del history.back() del cierre: ahora sí abre.
  emitir("popstate", {});
  assert.ok(capa(), "la capa se abre al resolverse el retroceso");
  assert.equal(historial.empujadas, 2);
  assert.equal(body.children.length, 2);

  // El siguiente «Atrás» es del usuario y la cierra.
  emitir("popstate", {});
  assert.equal(capa(), null);
  assert.equal(historial.atras, 1);
});

test("volver con «Atrás» desde otra página (bfcache) no muestra la capa abierta y consume su entrada (L51 b)", () => {
  const { context, body, pagina, historial, emitir, capa } = cargarNavbar();
  const origen = pagina.appendChild(new Nodo("button"));
  context.abrirCapaConfiguracion(origen);
  emitir("pageshow", { persisted: true });
  assert.equal(capa(), null, "la capa restaurada se quita");
  assert.equal(body.children.length, 1);
  assert.equal(pagina.inert, false);
  assert.equal(historial.atras, 1, "la entrada que agregó la capa se consume");
});

test("pageshow sin capa abierta, o en una carga normal, no toca el historial", () => {
  const { context, historial, emitir, capa } = cargarNavbar();
  emitir("pageshow", { persisted: true });
  assert.equal(historial.atras, 0);
  context.abrirCapaConfiguracion(null);
  emitir("pageshow", { persisted: false });
  assert.ok(capa());
  assert.equal(historial.atras, 0);
});

test("cada apertura carga el portal de nuevo: el iframe no se reutiliza (L49)", () => {
  const { context, capa, emitir } = cargarNavbar();
  context.abrirCapaConfiguracion(null);
  const primero = capa();
  context.cerrarCapaConfiguracion();
  assert.equal(capa(), null, "al cerrar, el iframe se destruye");
  emitir("popstate", {});
  context.abrirCapaConfiguracion(null);
  assert.ok(capa());
  assert.notEqual(capa(), primero);
});

test("el mensaje «cerrar» del panel cierra la capa; uno de otro origen no", () => {
  const { context, body, emitir, capa } = cargarNavbar();
  const { cerrar } = context.MENSAJES_CAPA_CONFIGURACION;
  context.abrirCapaConfiguracion(null);
  emitir("message", { origin: "https://otro.com", source: capa().contentWindow, data: { tipo: cerrar } });
  assert.equal(body.children.length, 2);
  emitir("message", { origin: ORIGEN, source: capa().contentWindow, data: { tipo: cerrar } });
  assert.equal(body.children.length, 1);
});

test("«Mi cuenta» del menú abre la capa con un clic simple", () => {
  const { context, capa } = cargarNavbar();
  const entrada = context.ENLACES_NAVEGACION_BASE.find((e) => e.texto === "Mi cuenta");
  const enlace = context.crearItemMenu(entrada);
  assert.equal(enlace.href, "/app/features/portal/", "el href sigue: Ctrl+clic abre la página");
  let prevenido = false;
  enlace.listeners.click[0]({ ...clic(), currentTarget: enlace, preventDefault() { prevenido = true; } });
  assert.equal(prevenido, true);
  assert.ok(capa());
});

/* Bloque C */

test("enlaceSaleDelPanel: los cambios de hash se quedan en el panel; otra página, otra consulta o mailto salen", () => {
  const actual = `${ORIGEN}/app/features/portal/?embebido=1#perfil`;
  assert.equal(enlaceSaleDelPanel("#cuenta", actual), false);
  assert.equal(enlaceSaleDelPanel(`${ORIGEN}/app/features/portal/?embebido=1#sesiones`, actual), false);
  assert.equal(enlaceSaleDelPanel("/privacidad.html", actual), true);
  assert.equal(enlaceSaleDelPanel("/app/features/portal/", actual), true);
  assert.equal(enlaceSaleDelPanel("mailto:hola@taudux.com", actual), true);
  assert.equal(enlaceSaleDelPanel("https://otro.com/", actual), true);
});

/* Bloque D */

test("portal.js: las salidas a otra página navegan por ventanaQueNavega(), no la ventana propia", () => {
  assert.doesNotMatch(PORTAL_JS_SOURCE, /\bwindow\.location\.href\s*=\s*"\/"/,
    "en la capa, `window.location.href = \"/\"` dejaría el inicio dentro del iframe");
  assert.match(PORTAL_JS_SOURCE, /ventanaQueNavega\(\)\.location\.href\s*=\s*"\/"/);
});

test("portal.js: en la capa, la ✕ y Esc avisan a la ventana de arriba en vez de navegar", () => {
  assert.match(PORTAL_JS_SOURCE, /MENSAJES_CAPA_CONFIGURACION\.cerrar/);
  assert.match(PORTAL_JS_SOURCE, /window\.top\.postMessage\([^)]*window\.location\.origin\)/,
    "el mensaje va sólo al mismo origen");
});
