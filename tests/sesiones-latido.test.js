/*
  Latido de sesión (T4 de sesiones-activas): sesiones.service.js, la salida de
  «Cerrar sesión» de auth.service.js y la función de ubicación de Vercel.

  Se ejecutan los archivos reales con `node:vm` —supabase-client.js,
  auth.service.js y sesiones.service.js, en el orden de las páginas— contra un
  navegador de mentira. Lo que se protege es lo que las migraciones 0055–0057
  dan por hecho: sin latido, la limpieza de pg_cron cierra la sesión a las 8 h
  (0056), y un latido que responde `false` tiene que sacar a la persona.
*/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const leer = (ruta) => fs.readFileSync(ruta, "utf8");
const FUENTE_CLIENTE = leer("src/app/core/supabase/supabase-client.js");
const FUENTE_AUTH = leer("src/app/core/auth/auth.service.js");
const RUTA_SERVICIO = "src/app/core/auth/sesiones.service.js";

const LLAVE_SESION = "sb-yqkvgfqplmbbcebrivpt-auth-token";
const SESION_ID = "2b7e1516-28ae-4d2a-a6d2-abf7158809cf";
const OTRA_SESION_ID = "9c1f0e7a-3b54-4c1e-8f2d-0a6b5c4d3e21";

// El relleno «??>???» da «+» y «/» en base64: en base64url son «-» y «_», que
// `atob` no acepta. Un decodificador que no los traduzca falla con este token.
function tokenCon(sessionId, extra = {}) {
  const payload = Buffer.from(
    JSON.stringify({ sub: "u1", session_id: sessionId, relleno: "??>???", ...extra })
  ).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.firma`;
}

const UA_SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const UA_FIREFOX_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";
const UA_CHROME_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1";
const UA_EDGE_ANDROID =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.0.0";

const HINTS_EDGE_ANDROID = Object.freeze({
  platform: "Android",
  platformVersion: "15.0.0",
  model: "SM-S918B",
  mobile: true,
  fullVersionList: [
    { brand: "Not)A;Brand", version: "99.0.0.0" },
    { brand: "Microsoft Edge", version: "130.0.2849.80" },
    { brand: "Chromium", version: "130.0.6723.103" },
  ],
});

const HINTS_CHROME_WINDOWS_11 = Object.freeze({
  platform: "Windows",
  platformVersion: "15.0.0",
  model: "",
  mobile: false,
  fullVersionList: [
    { brand: "Google Chrome", version: "130.0.6723.117" },
    { brand: "Chromium", version: "130.0.6723.117" },
    { brand: "Not?A_Brand", version: "99.0.0.0" },
  ],
});

const AHORA = Date.parse("2026-10-28T12:00:00Z");
const HORA = 60 * 60 * 1000;

const storageFalso = () => {
  const datos = new Map();
  return {
    datos,
    getItem: (k) => (datos.has(k) ? datos.get(k) : null),
    setItem: (k, v) => datos.set(k, String(v)),
    removeItem: (k) => datos.delete(k),
  };
};

// Los objetos que salen del contexto de vm tienen otro Object.prototype:
// pasarlos por JSON los deja comparables con deepEqual.
const plano = (valor) => JSON.parse(JSON.stringify(valor));

const vaciarMicrotareas = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
};

function crearArnes({
  recordar = false,
  token = tokenCon(SESION_ID),
  conSesion = true,
  respuestaLatido = () => ({ data: true, error: null }),
  respuestaSalir = () => ({ data: true, error: null }),
  respuestaCerrarDemas = () => ({ data: 2, error: null }),
  errorSignOut = null,
  respuestaUbicacion = { ok: true, cuerpo: { ciudad: "León", region: "GUA", pais: "MX" } },
  enIframe = false,
  visibilidad = "visible",
  ruta = "/app/features/portal/",
  userAgent = UA_SAFARI_IPHONE,
  hints = null,
  marcaUbicacion = null,
  ahora = AHORA,
  sinServicio = false,
  tokenGuardado = conSesion,
} = {}) {
  const local = storageFalso();
  const sesion = storageFalso();
  if (recordar) local.setItem("taudux_recordarme", "1");
  if (marcaUbicacion) local.setItem("taudux_ubicacion", JSON.stringify(marcaUbicacion));
  if (tokenGuardado) (recordar ? local : sesion).setItem(LLAVE_SESION, "token-guardado");

  const reloj = { ahora };
  const estado = {
    sesion: conSesion ? { access_token: token } : null,
    errorGetSession: null,
    alCambiar: null,
  };
  const registro = { rpc: [], signOut: [], fetch: [], orden: [], mensajes: [] };
  const timers = { intervalos: [], timeouts: [], limpiados: [] };
  const oyentes = { ventana: {}, documento: {} };
  const canales = [];

  const agregarOyente = (mapa) => (tipo, fn) => {
    (mapa[tipo] ||= []).push(fn);
  };

  const cliente = {
    auth: {
      async getSession() {
        if (estado.errorGetSession) return { data: { session: null }, error: estado.errorGetSession };
        return { data: { session: estado.sesion }, error: null };
      },
      async signOut(opciones) {
        registro.signOut.push(plano(opciones ?? {}));
        registro.orden.push("signOut");
        if (errorSignOut) return { error: errorSignOut };
        estado.sesion = null;
        return { error: null };
      },
      onAuthStateChange(fn) {
        estado.alCambiar = fn;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
    async rpc(nombre, parametros) {
      registro.rpc.push({ nombre, parametros: plano(parametros ?? null) });
      registro.orden.push(`rpc:${nombre}`);
      if (nombre === "sesion_latido") return respuestaLatido(parametros);
      if (nombre === "sesion_salir") return respuestaSalir();
      if (nombre === "sesiones_cerrar_demas") return respuestaCerrarDemas();
      return { data: true, error: null };
    },
  };

  class BroadcastChannelFalso {
    constructor(nombre) {
      this.nombre = nombre;
      this.onmessage = null;
      this.oyentes = [];
      canales.push(this);
    }
    postMessage(datos) {
      registro.mensajes.push({ canal: this.nombre, datos: plano(datos) });
    }
    addEventListener(tipo, fn) {
      if (tipo === "message") this.oyentes.push(fn);
    }
    recibir(datos) {
      const evento = { data: datos };
      if (this.onmessage) this.onmessage(evento);
      this.oyentes.forEach((fn) => fn(evento));
    }
  }

  class DateFalso extends Date {
    static now() {
      return reloj.ahora;
    }
  }

  const ventana = {
    localStorage: local,
    sessionStorage: sesion,
    supabase: { createClient: () => cliente },
    location: { origin: "https://taudux.com", pathname: ruta, search: "", hash: "", href: ruta },
    addEventListener: agregarOyente(oyentes.ventana),
  };
  ventana.top = enIframe ? {} : ventana;
  ventana.self = ventana;

  const documento = {
    visibilityState: visibilidad,
    addEventListener: agregarOyente(oyentes.documento),
  };

  const contexto = {
    console,
    window: ventana,
    document: documento,
    navigator: {
      userAgent,
      userAgentData: hints ? { getHighEntropyValues: async () => hints } : undefined,
    },
    localStorage: local,
    sessionStorage: sesion,
    atob,
    URL,
    URLSearchParams,
    Date: DateFalso,
    BroadcastChannel: BroadcastChannelFalso,
    addEventListener: agregarOyente(oyentes.ventana),
    async fetch(url, opciones) {
      registro.fetch.push({ url, opciones: plano(opciones ?? {}) });
      if (url === "/api/ubicacion") {
        if (respuestaUbicacion instanceof Error) throw respuestaUbicacion;
        return {
          ok: respuestaUbicacion.ok,
          async json() {
            return respuestaUbicacion.cuerpo;
          },
        };
      }
      return { ok: true, async json() { return null; } };
    },
    setInterval(fn, ms) {
      timers.intervalos.push({ fn, ms });
      return timers.intervalos.length;
    },
    clearInterval(id) {
      timers.limpiados.push(id);
    },
    setTimeout(fn, ms) {
      timers.timeouts.push({ fn, ms });
      return 1000 + timers.timeouts.length;
    },
    clearTimeout() {},
  };

  vm.createContext(contexto);
  vm.runInContext(FUENTE_CLIENTE, contexto);
  vm.runInContext(FUENTE_AUTH, contexto);
  if (!sinServicio) vm.runInContext(leer(RUTA_SERVICIO), contexto);

  const disparar = async (mapa, tipo, evento = {}) => {
    await Promise.all((mapa[tipo] || []).map((fn) => fn(evento)));
    await vaciarMicrotareas();
  };

  return {
    contexto,
    local,
    sesion,
    estado,
    registro,
    timers,
    canales,
    reloj,
    documento,
    ventana,
    latidos: () => registro.rpc.filter((r) => r.nombre === "sesion_latido"),
    arrancar: () => disparar(oyentes.documento, "DOMContentLoaded"),
    dispararVentana: (tipo, evento) => disparar(oyentes.ventana, tipo, evento),
    dispararDocumento: (tipo, evento) => disparar(oyentes.documento, tipo, evento),
    correrIntervalo: async () => {
      await Promise.all(timers.intervalos.map((t) => t.fn()));
      await vaciarMicrotareas();
    },
    correrTimeouts: async () => {
      const pendientes = timers.timeouts.splice(0);
      await Promise.all(pendientes.map((t) => t.fn()));
      await vaciarMicrotareas();
    },
    evaluar: (codigo) => vm.runInContext(codigo, contexto),
  };
}

/* ---------- Dispositivo (S13) ---------- */

test("dispositivoDesde uses Client Hints: «Edge 130 · Android 15» even when the user agent says Android 10", () => {
  const arnes = crearArnes();
  arnes.contexto.__ua = UA_EDGE_ANDROID;
  arnes.contexto.__hints = HINTS_EDGE_ANDROID;
  assert.deepEqual(plano(arnes.evaluar("dispositivoDesde(__ua, __hints)")), {
    navegador: "Edge",
    navegador_version: "130",
    sistema: "Android",
    sistema_version: "15",
    modelo: "SM-S918B",
  });
});

test("dispositivoDesde maps Windows platformVersion 13+ to Windows 11", () => {
  const arnes = crearArnes();
  arnes.contexto.__hints = HINTS_CHROME_WINDOWS_11;
  assert.deepEqual(plano(arnes.evaluar("dispositivoDesde('Mozilla/5.0 (Windows NT 10.0)', __hints)")), {
    navegador: "Chrome",
    navegador_version: "130",
    sistema: "Windows",
    sistema_version: "11",
    modelo: null,
  });
});

test("dispositivoDesde falls back to the user agent without Client Hints (Safari, Firefox, Chrome on iPhone)", () => {
  const arnes = crearArnes();
  const de = (ua) => {
    arnes.contexto.__ua = ua;
    return plano(arnes.evaluar("dispositivoDesde(__ua, null)"));
  };
  assert.deepEqual(de(UA_SAFARI_IPHONE), {
    navegador: "Safari",
    navegador_version: "17",
    sistema: "iOS",
    sistema_version: "17",
    modelo: "iPhone",
  });
  assert.deepEqual(de(UA_FIREFOX_WINDOWS), {
    navegador: "Firefox",
    navegador_version: "131",
    sistema: "Windows",
    sistema_version: null,
    modelo: null,
  });
  assert.deepEqual(de(UA_CHROME_IPHONE), {
    navegador: "Chrome",
    navegador_version: "130",
    sistema: "iOS",
    sistema_version: "18",
    modelo: "iPhone",
  });
});

test("sesionIdDe decodes a base64url payload and returns null for garbage", () => {
  const arnes = crearArnes();
  arnes.contexto.__token = tokenCon(SESION_ID);
  assert.equal(arnes.evaluar("sesionIdDe(__token)"), SESION_ID);
  assert.equal(arnes.evaluar("sesionIdDe('no-es-un-jwt')"), null);
  assert.equal(arnes.evaluar("sesionIdDe(null)"), null);
});

/* ---------- Latido (S7, S9, A6, L25) ---------- */

test("the first heartbeat sends a boolean p_recordarme, the device and the location", async () => {
  const arnes = crearArnes({ hints: HINTS_EDGE_ANDROID, userAgent: UA_EDGE_ANDROID });
  await arnes.arrancar();

  const [latido] = arnes.latidos();
  assert.ok(latido, "al cargar la página debe latir");
  assert.equal(latido.parametros.p_recordarme, false);
  assert.equal(latido.parametros.p_ciudad, "León");
  assert.equal(latido.parametros.p_region, "GUA");
  assert.equal(latido.parametros.p_pais, "MX");
  assert.equal(latido.parametros.p_dispositivo.navegador, "Edge");
  assert.equal(latido.parametros.p_dispositivo.sistema_version, "15");

  const marca = JSON.parse(arnes.local.getItem("taudux_ubicacion"));
  assert.deepEqual(marca, { session_id: SESION_ID, en: AHORA });
});

test("with «Recordarme» the heartbeat sends p_recordarme true", async () => {
  const arnes = crearArnes({ recordar: true });
  await arnes.arrancar();
  assert.equal(arnes.latidos()[0].parametros.p_recordarme, true);
});

test("the location is not requested again within 24 h of the same session", async () => {
  const arnes = crearArnes({ marcaUbicacion: { session_id: SESION_ID, en: AHORA - 23 * HORA } });
  await arnes.arrancar();

  assert.equal(arnes.registro.fetch.filter((f) => f.url === "/api/ubicacion").length, 0);
  const [latido] = arnes.latidos();
  assert.equal(latido.parametros.p_ciudad, null);
  assert.equal(latido.parametros.p_pais, null);
});

test("the location is requested again after 24 h or for another session", async () => {
  const vieja = crearArnes({ marcaUbicacion: { session_id: SESION_ID, en: AHORA - 25 * HORA } });
  await vieja.arrancar();
  assert.equal(vieja.latidos()[0].parametros.p_ciudad, "León");

  const otra = crearArnes({ marcaUbicacion: { session_id: OTRA_SESION_ID, en: AHORA - HORA } });
  await otra.arrancar();
  assert.equal(otra.latidos()[0].parametros.p_ciudad, "León");
  assert.equal(JSON.parse(otra.local.getItem("taudux_ubicacion")).session_id, SESION_ID);
});

test("a failed location request still beats and leaves no mark, so the next page retries", async () => {
  const caida = crearArnes({ respuestaUbicacion: new Error("sin red") });
  await caida.arrancar();
  assert.equal(caida.latidos().length, 1);
  assert.equal(caida.latidos()[0].parametros.p_ciudad, null);
  assert.equal(caida.local.getItem("taudux_ubicacion"), null);

  // Live Server no tiene /api: responde 404.
  const sinApi = crearArnes({ respuestaUbicacion: { ok: false, cuerpo: null } });
  await sinApi.arrancar();
  assert.equal(sinApi.latidos().length, 1);
  assert.equal(sinApi.local.getItem("taudux_ubicacion"), null);
});

test("later heartbeats on the same page skip device and location", async () => {
  const arnes = crearArnes({ hints: HINTS_EDGE_ANDROID });
  await arnes.arrancar();
  await arnes.correrIntervalo();

  const latidos = arnes.latidos();
  assert.equal(latidos.length, 2);
  assert.equal(latidos[1].parametros.p_dispositivo, null);
  assert.equal(latidos[1].parametros.p_ciudad, null);
  assert.equal(typeof latidos[1].parametros.p_recordarme, "boolean");
});

test("it beats every 60 s only while the tab is visible, and when it becomes visible again", async () => {
  const arnes = crearArnes();
  await arnes.arrancar();
  assert.equal(arnes.timers.intervalos.length, 1);
  assert.equal(arnes.timers.intervalos[0].ms, 60000);

  arnes.documento.visibilityState = "hidden";
  await arnes.correrIntervalo();
  await arnes.dispararDocumento("visibilitychange");
  assert.equal(arnes.latidos().length, 1, "oculta no late");

  arnes.documento.visibilityState = "visible";
  await arnes.dispararDocumento("visibilitychange");
  assert.equal(arnes.latidos().length, 2, "al volver visible late");
  await arnes.correrIntervalo();
  assert.equal(arnes.latidos().length, 3);
});

test("a page restored from the back/forward cache beats", async () => {
  const arnes = crearArnes();
  await arnes.arrancar();
  await arnes.dispararVentana("pageshow", { persisted: false });
  assert.equal(arnes.latidos().length, 1);
  await arnes.dispararVentana("pageshow", { persisted: true });
  assert.equal(arnes.latidos().length, 2);
});

test("it does not start inside an iframe, on auth pages or without a session", async () => {
  for (const opciones of [
    { enIframe: true },
    { ruta: "/app/features/auth/login/" },
    { ruta: "/app/features/auth/oauth-callback/" },
    { conSesion: false },
  ]) {
    const arnes = crearArnes(opciones);
    await arnes.arrancar();
    await arnes.dispararVentana("pagehide", { persisted: false });
    assert.equal(arnes.latidos().length, 0, JSON.stringify(opciones));
    assert.equal(arnes.timers.intervalos.length, 0, JSON.stringify(opciones));
    assert.equal(arnes.registro.fetch.length, 0, JSON.stringify(opciones));
  }
});

test("a heartbeat answered false signs out locally and goes to login with the notice and the way back", async () => {
  const arnes = crearArnes({ respuestaLatido: () => ({ data: false, error: null }) });
  arnes.ventana.location.search = "?tab=cuenta";
  await arnes.arrancar();

  assert.deepEqual(arnes.registro.signOut, [{ scope: "local" }]);
  assert.equal(arnes.local.getItem(LLAVE_SESION), null);
  assert.equal(arnes.sesion.getItem(LLAVE_SESION), null);
  assert.deepEqual(arnes.timers.limpiados, [1], "deja de latir");
  assert.equal(
    arnes.ventana.location.href,
    "/app/features/auth/login/?next=%2Fapp%2Ffeatures%2Fportal%2F%3Ftab%3Dcuenta&sesion=cerrada"
  );
  assert.equal(
    JSON.parse(arnes.local.getItem("taudux_auth_next")).ruta,
    "/app/features/portal/?tab=cuenta"
  );

  // Un segundo `false` (otro latido en vuelo) no repite el cierre.
  await arnes.correrIntervalo();
  assert.equal(arnes.registro.signOut.length, 1);
});

test("a heartbeat that fails (network, RPC not deployed yet) does nothing", async () => {
  for (const respuestaLatido of [
    () => ({ data: null, error: { code: "PGRST202", message: "function not found" } }),
    () => { throw new Error("Failed to fetch"); },
    () => ({ data: null, error: null }),
  ]) {
    const arnes = crearArnes({ respuestaLatido });
    await arnes.arrancar();
    await arnes.correrIntervalo();
    assert.equal(arnes.registro.signOut.length, 0);
    assert.equal(arnes.ventana.location.href, "/app/features/portal/");
    assert.equal(arnes.timers.limpiados.length, 0);
  }
});

const LOGIN_CON_AVISO =
  "/app/features/auth/login/?next=%2Fapp%2Ffeatures%2Fportal%2F&sesion=cerrada";

/*
  Pestaña oculta más que la vida del JWT, cuya sesión se cerró mientras tanto:
  al volver, supabase-js no puede renovar el token y borra la sesión local en
  silencio. El latido iría con la clave anónima y recibiría un error, no
  `false`; sin esta rama la persona quedaría fuera sin aviso.
*/
test("a session that vanished locally (refresh rejected) goes to login with the notice", async () => {
  const arnes = crearArnes();
  await arnes.arrancar();
  const antes = arnes.latidos().length;

  arnes.estado.sesion = null;
  await arnes.dispararDocumento("visibilitychange");

  assert.equal(arnes.latidos().length, antes, "no late con la clave anónima");
  assert.equal(arnes.ventana.location.href, LOGIN_CON_AVISO);
  assert.equal(arnes.sesion.getItem(LLAVE_SESION), null);
});

test("a stored token that can no longer be refreshed on load goes to login with the notice", async () => {
  const arnes = crearArnes({ conSesion: false, tokenGuardado: true });
  await arnes.arrancar();
  assert.equal(arnes.latidos().length, 0);
  assert.equal(arnes.ventana.location.href, LOGIN_CON_AVISO);
});

test("a getSession error (offline refresh) is not a closed session", async () => {
  const arnes = crearArnes();
  await arnes.arrancar();
  arnes.estado.errorGetSession = { name: "AuthRetryableFetchError", status: 0 };
  await arnes.correrIntervalo();
  assert.equal(arnes.ventana.location.href, "/app/features/portal/");
  assert.equal(arnes.registro.signOut.length, 0);

  const alCargar = crearArnes();
  alCargar.estado.errorGetSession = { name: "AuthRetryableFetchError", status: 0 };
  await alCargar.arrancar();
  assert.equal(alCargar.latidos().length, 0);
  assert.equal(alCargar.ventana.location.href, "/app/features/portal/");
});

test("a sign-out requested by the page itself is not sent to login with the notice", async () => {
  const arnes = crearArnes();
  await arnes.arrancar();
  await arnes.evaluar("salirDeEstaSesion()");
  await arnes.correrIntervalo();
  assert.equal(arnes.ventana.location.href, "/app/features/portal/");
});

test("a heartbeat answered false while this page is signing out does not send it to login", async () => {
  let cerrada = false;
  const arnes = crearArnes({
    respuestaLatido: () => ({ data: !cerrada, error: null }),
    // Un latido cae justo entre sesion_salir y el signOut.
    respuestaSalir: async () => {
      cerrada = true;
      await arnes.correrIntervalo();
      return { data: true, error: null };
    },
  });
  await arnes.arrancar();
  await arnes.evaluar("salirDeEstaSesion()");
  assert.equal(arnes.ventana.location.href, "/app/features/portal/");
  assert.deepEqual(arnes.registro.signOut, [{ scope: "local" }]);
});

test("a failed heartbeat keeps device and location for the next one", async () => {
  let fallar = true;
  const arnes = crearArnes({
    hints: HINTS_EDGE_ANDROID,
    respuestaLatido: () => (fallar ? { data: null, error: { code: "PGRST202" } } : { data: true, error: null }),
  });
  await arnes.arrancar();
  assert.equal(arnes.local.getItem("taudux_ubicacion"), null, "sin latido guardado no hay marca");

  fallar = false;
  await arnes.correrIntervalo();
  const [, segundo] = arnes.latidos();
  assert.equal(segundo.parametros.p_dispositivo.navegador, "Edge");
  assert.equal(segundo.parametros.p_ciudad, "León");
  assert.equal(JSON.parse(arnes.local.getItem("taudux_ubicacion")).session_id, SESION_ID);
});

/* ---------- Pestaña cerrada (S4, L26) ---------- */

test("pagehide without «Recordarme» sends the keepalive notice with the current token and tells the other tabs", async () => {
  const arnes = crearArnes();
  await arnes.arrancar();

  // El token se renovó después del arranque: el aviso usa el vigente.
  const renovado = tokenCon(SESION_ID, { iat: 2 });
  arnes.estado.alCambiar("TOKEN_REFRESHED", { access_token: renovado });

  await arnes.dispararVentana("pagehide", { persisted: false });

  const avisos = arnes.registro.fetch.filter((f) => f.url.endsWith("/rpc/sesion_pestana_cerrada"));
  assert.equal(avisos.length, 1);
  const [aviso] = avisos;
  assert.equal(aviso.url, "https://yqkvgfqplmbbcebrivpt.supabase.co/rest/v1/rpc/sesion_pestana_cerrada");
  assert.equal(aviso.opciones.method, "POST");
  assert.equal(aviso.opciones.keepalive, true);
  assert.equal(aviso.opciones.headers.Authorization, `Bearer ${renovado}`);
  assert.match(aviso.opciones.headers.apikey, /^eyJ/);
  assert.equal(aviso.opciones.headers["Content-Type"], "application/json");
  assert.equal(aviso.opciones.body, "{}");

  assert.deepEqual(arnes.registro.mensajes, [
    { canal: "taudux_sesiones", datos: { tipo: "pestana-cerrada", session_id: SESION_ID } },
  ]);
});

test("pagehide with «Recordarme» sends nothing", async () => {
  const arnes = crearArnes({ recordar: true });
  await arnes.arrancar();
  await arnes.dispararVentana("pagehide", { persisted: false });
  assert.equal(arnes.registro.fetch.filter((f) => f.url.includes("sesion_pestana_cerrada")).length, 0);
  assert.equal(arnes.registro.mensajes.length, 0);
});

test("a tab of the same session that hears another one closing beats after a delay, even hidden", async () => {
  const arnes = crearArnes({ visibilidad: "hidden" });
  await arnes.arrancar();
  const antes = arnes.latidos().length;
  const [canal] = arnes.canales;

  canal.recibir({ tipo: "pestana-cerrada", session_id: OTRA_SESION_ID });
  canal.recibir({ tipo: "otra-cosa", session_id: SESION_ID });
  assert.equal(arnes.timers.timeouts.length, 0, "otra sesión u otro mensaje: se ignora");

  canal.recibir({ tipo: "pestana-cerrada", session_id: SESION_ID });
  assert.equal(arnes.timers.timeouts.length, 1);
  assert.equal(arnes.timers.timeouts[0].ms, 5000);
  assert.equal(arnes.latidos().length, antes, "no late antes de la demora");

  await arnes.correrTimeouts();
  assert.equal(arnes.latidos().length, antes + 1);
});

/* ---------- «Cerrar sesión» solo en este dispositivo (L27) ---------- */

test("salirDeEstaSesion records the reason first and then signs out locally", async () => {
  const arnes = crearArnes({ recordar: true });
  const resultado = plano(await arnes.evaluar("salirDeEstaSesion()"));

  assert.deepEqual(resultado, { ok: true });
  assert.deepEqual(arnes.registro.orden, ["rpc:sesion_salir", "signOut"]);
  assert.deepEqual(arnes.registro.signOut, [{ scope: "local" }]);
  assert.equal(arnes.local.getItem("taudux_recordarme"), null, "cerrar sesión olvida «Recordarme»");
});

test("salirDeEstaSesion still signs out when sesion_salir fails", async () => {
  for (const respuestaSalir of [
    () => ({ data: null, error: { code: "PGRST202" } }),
    () => { throw new Error("Failed to fetch"); },
  ]) {
    const arnes = crearArnes({ respuestaSalir });
    const resultado = plano(await arnes.evaluar("salirDeEstaSesion()"));
    assert.deepEqual(resultado, { ok: true });
    assert.deepEqual(arnes.registro.signOut, [{ scope: "local" }]);
  }
});

test("salirDeEstaSesion clears the local session when the database already closed it but signOut errs", async () => {
  const arnes = crearArnes({ errorSignOut: { code: "unexpected_failure", status: 500 } });
  const resultado = plano(await arnes.evaluar("salirDeEstaSesion()"));
  assert.deepEqual(resultado, { ok: true });
  assert.equal(arnes.local.getItem(LLAVE_SESION), null);
  assert.equal(arnes.sesion.getItem(LLAVE_SESION), null);
});

test("salirDeEstaSesion reports the error when nothing was closed", async () => {
  const arnes = crearArnes({
    respuestaSalir: () => ({ data: null, error: { code: "PGRST202" } }),
    errorSignOut: { code: "unexpected_failure", status: 500 },
  });
  const resultado = plano(await arnes.evaluar("salirDeEstaSesion()"));
  assert.equal(resultado.ok, false);
  assert.equal(arnes.sesion.getItem(LLAVE_SESION), "token-guardado");
});

/* ---------- «Cerrar las demás» por la base, con respaldo (L30, L33) ---------- */

test("cerrarLasDemasSesiones closes through the database and keeps this session", async () => {
  const arnes = crearArnes();
  const resultado = plano(await arnes.evaluar("cerrarLasDemasSesiones()"));
  assert.deepEqual(resultado, { ok: true, cerradas: 2, respaldo: false });
  assert.deepEqual(arnes.registro.orden, ["rpc:sesiones_cerrar_demas"]);
  assert.equal(arnes.registro.signOut.length, 0);
});

test("cerrarLasDemasSesiones falls back to Supabase scope others when the RPC fails (L33)", async () => {
  for (const respuestaCerrarDemas of [
    () => ({ data: null, error: { code: "PGRST202" } }),
    () => { throw new Error("Failed to fetch"); },
  ]) {
    const arnes = crearArnes({ respuestaCerrarDemas, recordar: true });
    const resultado = plano(await arnes.evaluar("cerrarLasDemasSesiones()"));
    assert.deepEqual(resultado, { ok: true, cerradas: null, respaldo: true });
    assert.deepEqual(arnes.registro.signOut, [{ scope: "others" }]);
    assert.equal(arnes.local.getItem(LLAVE_SESION), "token-guardado", "esta sesión sigue abierta");
    assert.equal(arnes.local.getItem("taudux_recordarme"), "1", "esta sesión conserva «Recordarme»");
  }
});

test("after the fallback, a heartbeat answering false still sends this tab to the login", async () => {
  const arnes = crearArnes({ respuestaCerrarDemas: () => ({ data: null, error: { code: "PGRST202" } }) });
  await arnes.evaluar("cerrarLasDemasSesiones()");
  assert.equal(await arnes.evaluar("cierreDeSesionSolicitado"), false);
});

test("cerrarLasDemasSesiones reports failure when the fallback fails too", async () => {
  const arnes = crearArnes({
    respuestaCerrarDemas: () => ({ data: null, error: { code: "PGRST202" } }),
    errorSignOut: { code: "unexpected_failure", status: 500 },
  });
  const resultado = plano(await arnes.evaluar("cerrarLasDemasSesiones()"));
  assert.equal(resultado.ok, false);
});

test("cerrarSesion() keeps its global default (password reset still closes every session)", async () => {
  const arnes = crearArnes({ sinServicio: true });
  await arnes.evaluar("cerrarSesion()");
  assert.deepEqual(arnes.registro.signOut, [{ scope: "global" }]);
  assert.match(
    leer("src/app/features/auth/reset-password/reset-password.js"),
    /const cierre = await cerrarSesion\(\);/
  );
});

test("the menu and the portal «Cerrar sesión» close only this device", () => {
  const navbar = leer("src/app/shared/navbar/navbar.js");
  const salir = navbar.match(/async function salirYVolver[\s\S]*?\n}\n/);
  assert.ok(salir, "no se encontró salirYVolver");
  assert.match(salir[0], /await salirDeEstaSesion\(\)/);
  assert.doesNotMatch(salir[0], /cerrarSesion\(/);

  const portal = leer("src/app/features/portal/portal.js");
  const cierre = portal.match(/function configurarCierreSesion\(\)[\s\S]*?\n  }\n/);
  assert.ok(cierre, "no se encontró configurarCierreSesion");
  assert.match(cierre[0], /await salirDeEstaSesion\(\)/);
  assert.doesNotMatch(cierre[0], /cerrarSesion\(/);
});

/* ---------- Login con aviso (S9) ---------- */

test("login shows «Tu sesión se cerró. Vuelve a iniciar sesión.» with ?sesion=cerrada", () => {
  const login = leer("src/app/features/auth/login/login.js");
  assert.match(
    login,
    /parametrosLogin\.get\("sesion"\) === "cerrada"\) \{(?:\s*\/\/[^\n]*)*\s*mostrarEstadoAuth\("Tu sesión se cerró\. Vuelve a iniciar sesión\.", "info", false\);/
  );
});

/* ---------- Páginas ---------- */

function htmlDe(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entrada) => {
    const ruta = path.join(dir, entrada.name);
    if (entrada.isDirectory()) return htmlDe(ruta);
    return entrada.name.endsWith(".html") ? [ruta] : [];
  });
}

test("every page with the navbar loads sesiones.service.js between auth.service.js and navbar.js", () => {
  const paginas = htmlDe("src").filter((ruta) => leer(ruta).includes("/app/shared/navbar/navbar.js"));
  assert.ok(paginas.length >= 29, `solo ${paginas.length} páginas con navbar`);
  for (const pagina of paginas) {
    const html = leer(pagina);
    const auth = html.indexOf('src="/app/core/auth/auth.service.js"');
    const servicio = html.indexOf('src="/app/core/auth/sesiones.service.js"');
    const navbar = html.indexOf('src="/app/shared/navbar/navbar.js"');
    assert.ok(auth >= 0 && servicio > auth && servicio < navbar, pagina);
  }
});

/*
  Los scripts clásicos comparten el ámbito global: un `const` que repita uno de
  otro script tira un SyntaxError y la página queda muerta. Este archivo entra
  en 29 páginas, así que ninguno de sus nombres puede estar en otro script de
  esas páginas.
*/
test("sesiones.service.js declares no global that another script of its pages declares", () => {
  const globalesDe = (fuente) => new Set(
    [...fuente.matchAll(/^(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)].map(([, nombre]) => nombre),
  );
  const propios = globalesDe(leer(RUTA_SERVICIO));
  const paginas = htmlDe("src").filter((ruta) => leer(ruta).includes("/app/core/auth/sesiones.service.js"));
  for (const pagina of paginas) {
    for (const [, src] of leer(pagina).matchAll(/<script\b[^>]*\ssrc="(\/[^"]+)"/g)) {
      if (src === "/app/core/auth/sesiones.service.js") continue;
      const archivo = path.join("src", src);
      if (!fs.existsSync(archivo)) continue;
      for (const nombre of globalesDe(leer(archivo))) {
        assert.ok(!propios.has(nombre), `${nombre} se declara también en ${src} (${pagina})`);
      }
    }
  }
});

/* ---------- api/ubicacion.js (S2) ---------- */

function llamarUbicacion({ method = "GET", headers = {} } = {}) {
  delete require.cache[require.resolve("../api/ubicacion.js")];
  const manejador = require("../api/ubicacion.js");
  const res = {
    statusCode: 200,
    cabeceras: {},
    cuerpo: null,
    setHeader(nombre, valor) {
      this.cabeceras[nombre.toLowerCase()] = valor;
    },
    end(cuerpo) {
      this.cuerpo = cuerpo ?? null;
    },
  };
  manejador({ method, headers }, res);
  return res;
}

test("api/ubicacion decodes the city Vercel computed and is never cached", () => {
  const res = llamarUbicacion({
    headers: { "x-vercel-ip-city": "Le%C3%B3n", "x-vercel-ip-country-region": "GUA", "x-vercel-ip-country": "MX" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.cabeceras["cache-control"], "no-store");
  assert.match(res.cabeceras["content-type"], /^application\/json/);
  assert.deepEqual(JSON.parse(res.cuerpo), { ciudad: "León", region: "GUA", pais: "MX" });
});

test("api/ubicacion returns nulls for missing or malformed headers", () => {
  const vacio = llamarUbicacion();
  assert.deepEqual(JSON.parse(vacio.cuerpo), { ciudad: null, region: null, pais: null });

  const roto = llamarUbicacion({ headers: { "x-vercel-ip-city": "%E0%A4%A", "x-vercel-ip-country": "  " } });
  assert.deepEqual(JSON.parse(roto.cuerpo), { ciudad: null, region: null, pais: null });
});

test("api/ubicacion only answers GET", () => {
  const res = llamarUbicacion({ method: "POST" });
  assert.equal(res.statusCode, 405);
  assert.equal(res.cabeceras.allow, "GET");
  assert.equal(res.cabeceras["cache-control"], "no-store");
});
