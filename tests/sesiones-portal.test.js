/*
  «Sesiones activas» en el portal (T5 de sesiones-activas).

  Bloque A — núcleo puro (sesiones.nucleo.js): estados y plazos de S4, orden
  de la lista, motivos de cierre (S10), ubicación, nombres de dispositivo y
  fechas. Las filas imitan lo que devuelve `sesiones_listar()` (0055:216).

  Bloque B — cableado de la página: scripts en orden, el controlador sólo
  escribe texto (la ciudad y el user agent vienen de fuera) y el cambio de
  contraseña cierra las demás por la base (L30, L33).
*/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

const {
  REGLAS_SESION,
  vidaDeSesion,
  agruparSesiones,
  fraseMotivo,
  textoUbicacion,
  nombreDispositivo,
  tipoDispositivo,
  fechaCompleta,
  fechaRelativa,
  textoCierre,
  textoInactivas,
  ETIQUETAS_ESTADO,
  CERRADAS_POR_PAGINA,
  claseDispositivo,
  resumirPorTipo,
  textoNoReconocesResumen,
} = require(path.join(ROOT, "src/app/features/portal/sesiones.nucleo.js"));

const MIN = 60 * 1000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;
// 27 oct 2026, 6:09 p.m. en la Ciudad de México (UTC-6, sin horario de verano).
const AHORA = Date.parse("2026-10-28T00:09:00Z");
const ZONA = "America/Mexico_City";

const iso = (ms) => new Date(ms).toISOString();

function fila(extra = {}) {
  return {
    id: "s-" + Math.random().toString(16).slice(2),
    es_actual: false,
    iniciada_en: iso(AHORA - 2 * HORA),
    ultimo_uso: iso(AHORA - 1 * MIN),
    pestana_cerrada_en: null,
    recordarme: false,
    ciudad: "León",
    region: "GUA",
    pais: "MX",
    user_agent: "",
    navegador: "Safari",
    navegador_version: "17",
    sistema: "iOS",
    sistema_version: "17",
    modelo: "iPhone",
    cerrada_en: null,
    motivo_cierre: null,
    ...extra,
  };
}

/* ---------- Bloque A: estados y plazos (S4) ---------- */

test("S4 rules: 3 min active, 1 h / 24 h without signal, 8 h / 30 days idle, 24 h / no total limit, 5 min after the tab closes", () => {
  assert.equal(REGLAS_SESION.activaMs, 3 * MIN);
  assert.deepEqual(REGLAS_SESION.sinRecordarme, { senalMs: HORA, inactividadMs: 8 * HORA, totalMs: 24 * HORA });
  assert.deepEqual(REGLAS_SESION.conRecordarme, { senalMs: 24 * HORA, inactividadMs: 30 * DIA, totalMs: Infinity });
  assert.equal(REGLAS_SESION.pestanaCerradaMs, 5 * MIN);
});

test("a heartbeat under 3 min ago is «Activa ahora»", () => {
  const vida = vidaDeSesion(fila({ ultimo_uso: iso(AHORA - 2 * MIN - 59 * 1000) }), AHORA);
  assert.equal(vida.estado, "activa");
  assert.equal(ETIQUETAS_ESTADO[vida.estado], "Activa ahora");
});

test("without «Recordarme»: no signal from 3 min to 1 h, idle from 1 h, closes at 8 h idle", () => {
  const uso = AHORA - 30 * MIN;
  const vida = vidaDeSesion(fila({ ultimo_uso: iso(uso) }), AHORA);
  assert.equal(vida.estado, "sin-senal");
  assert.equal(ETIQUETAS_ESTADO[vida.estado], "Sin señal");
  assert.equal(vida.inactivaDesde.getTime(), uso + HORA);
  assert.equal(vida.seCerrara.getTime(), uso + 8 * HORA);
  assert.equal(vida.causa, "inactividad");

  const inactiva = vidaDeSesion(fila({ ultimo_uso: iso(AHORA - HORA) }), AHORA);
  assert.equal(inactiva.estado, "inactiva");
  assert.equal(ETIQUETAS_ESTADO.inactiva, "Inactiva");
});

test("without «Recordarme» the 24 h total limit wins when it comes first", () => {
  const inicio = AHORA - 20 * HORA;
  const vida = vidaDeSesion(fila({ iniciada_en: iso(inicio), ultimo_uso: iso(AHORA - 10 * MIN) }), AHORA);
  assert.equal(vida.seCerrara.getTime(), inicio + 24 * HORA);
  assert.equal(vida.causa, "límite");
});

test("with «Recordarme»: no signal up to 24 h and closes only after 30 days idle (L40)", () => {
  const inicio = AHORA - 3 * DIA;
  const uso = AHORA - 5 * HORA;
  const vida = vidaDeSesion(fila({ recordarme: true, iniciada_en: iso(inicio), ultimo_uso: iso(uso) }), AHORA);
  assert.equal(vida.estado, "sin-senal");
  assert.equal(vida.inactivaDesde.getTime(), uso + 24 * HORA);
  assert.equal(vida.seCerrara.getTime(), uso + 30 * DIA);
  assert.equal(vida.causa, "inactividad");

  const inactiva = vidaDeSesion(fila({ recordarme: true, iniciada_en: iso(inicio), ultimo_uso: iso(AHORA - 2 * DIA) }), AHORA);
  assert.equal(inactiva.estado, "inactiva");
});

test("with «Recordarme» there is no total limit: in use 31 days after signing in, it stays open (L40)", () => {
  const uso = AHORA - MIN;
  const vida = vidaDeSesion(fila({ recordarme: true, iniciada_en: iso(AHORA - 31 * DIA), ultimo_uso: iso(uso) }), AHORA);
  assert.equal(vida.estado, "activa");
  assert.equal(vida.seCerrara.getTime(), uso + 30 * DIA);
  assert.equal(vida.causa, "inactividad");
  assert.match(textoCierre(vida, AHORA, ZONA), /si no se usa$/);
});

test("a tie between idleness and the total limit is the limit: using it would not extend it", () => {
  const vida = vidaDeSesion(fila({ iniciada_en: iso(AHORA - 20 * HORA), ultimo_uso: iso(AHORA - 4 * HORA) }), AHORA);
  assert.equal(vida.causa, "límite");
  assert.doesNotMatch(textoCierre(vida, AHORA, ZONA), /si no se usa/);
});

test("exactly 3 min without a heartbeat is no longer active", () => {
  assert.equal(vidaDeSesion(fila({ ultimo_uso: iso(AHORA - 3 * MIN) }), AHORA).estado, "sin-senal");
});

test("a row with cerrada_en goes to the closed list even without a reason", () => {
  const grupos = agruparSesiones([fila({ cerrada_en: iso(AHORA - HORA), motivo_cierre: null })], AHORA);
  assert.equal(grupos.cerradas.length, 1);
  assert.equal(grupos.otras.length, 0);
});

test("a session with no presence row follows the rules without «Recordarme» (L19)", () => {
  const vida = vidaDeSesion(fila({ recordarme: null, ultimo_uso: iso(AHORA - 2 * HORA) }), AHORA);
  assert.equal(vida.recordarme, false);
  assert.equal(vida.estado, "inactiva");
  assert.equal(vida.seCerrara.getTime(), AHORA - 2 * HORA + 8 * HORA);
});

test("never idle when the limit closes it first: inactivaDesde is null", () => {
  const inicio = AHORA - 23 * HORA - 30 * MIN;
  const vida = vidaDeSesion(fila({ iniciada_en: iso(inicio), ultimo_uso: iso(AHORA - 10 * MIN) }), AHORA);
  assert.equal(vida.inactivaDesde, null);
  assert.equal(vida.estado, "sin-senal");
});

test("a closed tab still alive gets its own badge and closes 5 min after the event (L32)", () => {
  const evento = AHORA - 2 * MIN;
  const vida = vidaDeSesion(fila({ pestana_cerrada_en: iso(evento), ultimo_uso: iso(AHORA - 2 * MIN) }), AHORA);
  assert.equal(vida.estado, "pestana-cerrada");
  assert.equal(ETIQUETAS_ESTADO[vida.estado], "Pestaña cerrada");
  assert.equal(vida.seCerrara.getTime(), evento + 5 * MIN);
  assert.equal(vida.causa, "pestaña cerrada");
});

test("the closed-tab mark is ignored with «Recordarme» and on the current session, like 0056", () => {
  const evento = iso(AHORA - 2 * MIN);
  assert.notEqual(vidaDeSesion(fila({ recordarme: true, pestana_cerrada_en: evento }), AHORA).estado, "pestana-cerrada");
  assert.notEqual(vidaDeSesion(fila({ es_actual: true, pestana_cerrada_en: evento }), AHORA).estado, "pestana-cerrada");
});

/* ---------- Agrupación y orden ---------- */

test("groups: current first, others by state (active → no signal → closed tab), idle folded, closed by date", () => {
  const actual = fila({ id: "actual", es_actual: true });
  const activa = fila({ id: "activa", ultimo_uso: iso(AHORA - 1 * MIN) });
  const senalVieja = fila({ id: "senal-vieja", ultimo_uso: iso(AHORA - 50 * MIN) });
  const senalNueva = fila({ id: "senal-nueva", ultimo_uso: iso(AHORA - 10 * MIN) });
  const pestana = fila({ id: "pestana", ultimo_uso: iso(AHORA - 1 * MIN), pestana_cerrada_en: iso(AHORA - 1 * MIN) });
  const inactiva = fila({ id: "inactiva", ultimo_uso: iso(AHORA - 3 * HORA) });
  const cerradaVieja = fila({ id: "cerrada-vieja", cerrada_en: iso(AHORA - 3 * DIA), motivo_cierre: "inactividad" });
  const cerradaNueva = fila({ id: "cerrada-nueva", cerrada_en: iso(AHORA - 1 * HORA), motivo_cierre: "límite" });

  const grupos = agruparSesiones(
    [cerradaVieja, inactiva, senalVieja, pestana, activa, cerradaNueva, senalNueva, actual],
    AHORA
  );
  assert.equal(grupos.actual.fila.id, "actual");
  assert.deepEqual(grupos.otras.map((s) => s.fila.id), ["activa", "senal-nueva", "senal-vieja", "pestana"]);
  assert.deepEqual(grupos.inactivas.map((s) => s.fila.id), ["inactiva"]);
  assert.deepEqual(grupos.cerradas.map((s) => s.fila.id), ["cerrada-nueva", "cerrada-vieja"]);
});

test("no current row (e.g. right after a password change) leaves actual null", () => {
  const grupos = agruparSesiones([fila()], AHORA);
  assert.equal(grupos.actual, null);
  assert.equal(grupos.otras.length, 1);
});

test("closed sessions show 10 at a time (L31)", () => {
  assert.equal(CERRADAS_POR_PAGINA, 10);
});

test("«Mostrar N sesión inactiva» agrees in number", () => {
  assert.equal(textoInactivas(1), "Mostrar 1 sesión inactiva");
  assert.equal(textoInactivas(3), "Mostrar 3 sesiones inactivas");
});

/* ---------- Motivos (S10, L31) ---------- */

test("each close reason has its clear phrase; an unknown one says «Sesión cerrada»", () => {
  const esperadas = {
    "cerrada por ti": "Cerrada por ti",
    "cerraste sesión": "Cerraste sesión",
    inactividad: "Por inactividad",
    "límite": "Llegó a su límite de tiempo",
    "pestaña cerrada": "Se cerró la pestaña",
    "sesión terminada": "Terminó la sesión",
    "cambio de sistema": "Cierre general por actualización",
  };
  for (const [motivo, frase] of Object.entries(esperadas)) assert.equal(fraseMotivo(motivo), frase);
  assert.equal(fraseMotivo("otro"), "Sesión cerrada");
  assert.equal(fraseMotivo(null), "Sesión cerrada");
});

test("the phrases cover every reason the CHECK of 0056 allows", () => {
  const sql = read("supabase/migrations/0056_sesiones_limpieza_pg_cron.sql");
  const check = sql.match(/motivo_cierre in \(([^)]*)\)/)[1];
  const motivos = [...check.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.equal(motivos.length, 7);
  for (const motivo of motivos) assert.notEqual(fraseMotivo(motivo), "Sesión cerrada", motivo);
});

/* ---------- Ubicación (L30) ---------- */

test("location is «City, Country» with the country name in Spanish, never the region code", () => {
  assert.equal(textoUbicacion({ ciudad: "León", region: "GUA", pais: "MX" }), "León, México");
  assert.equal(textoUbicacion({ ciudad: null, region: "GUA", pais: "MX" }), "México");
  assert.equal(textoUbicacion({ ciudad: "Austin", pais: "US" }), "Austin, Estados Unidos");
  assert.equal(textoUbicacion({ ciudad: null, pais: null }), "Ubicación desconocida");
  assert.equal(textoUbicacion({ ciudad: "", pais: "" }), "Ubicación desconocida");
});

test("a malformed country code falls back to the code itself instead of throwing", () => {
  assert.equal(textoUbicacion({ ciudad: "X", pais: "123456" }), "X, 123456");
});

/* ---------- Dispositivo (S1, S13) ---------- */

test("device names read «Browser (System)» like the attachment; iOS uses the model (L66)", () => {
  assert.equal(nombreDispositivo({ navegador: "Safari", sistema: "iOS", modelo: "iPhone" }), "Safari (iPhone)");
  assert.equal(nombreDispositivo({ navegador: "Edge", sistema: "Android", modelo: "SM-S918B" }), "Edge (Android)");
  assert.equal(nombreDispositivo({ navegador: "Chrome", sistema: "Windows" }), "Chrome (Windows)");
  assert.equal(nombreDispositivo({ navegador: null, sistema: "Linux" }), "Linux");
  assert.equal(nombreDispositivo({ navegador: "Firefox", sistema: null }), "Firefox");
  assert.equal(nombreDispositivo({}), "Dispositivo desconocido");
});

test("phones and tablets get the mobile icon, everything else the computer", () => {
  assert.equal(tipoDispositivo({ sistema: "iOS" }), "movil");
  assert.equal(tipoDispositivo({ sistema: "Android" }), "movil");
  assert.equal(tipoDispositivo({ sistema: "Windows" }), "computadora");
  assert.equal(tipoDispositivo({}), "computadora");
});

/* ---------- Fechas ---------- */

test("relative dates: today, tomorrow, yesterday, or day and month, in the given time zone", () => {
  assert.equal(fechaRelativa(AHORA + 2 * MIN, AHORA, ZONA), "hoy a las 6:11 p.m.");
  assert.equal(fechaRelativa(AHORA + 8 * HORA, AHORA, ZONA), "mañana a las 2:09 a.m.");
  assert.equal(fechaRelativa(AHORA - 20 * HORA, AHORA, ZONA), "ayer a las 10:09 p.m.");
  assert.equal(fechaRelativa(AHORA + 10 * DIA, AHORA, ZONA), "el 6 nov a las 6:09 p.m.");
});

test("closing text: «si no se usa» only when idleness closes it; a closed tab says «a las HH:MM»", () => {
  const porInactividad = vidaDeSesion(fila({ ultimo_uso: iso(AHORA - 30 * MIN) }), AHORA);
  assert.equal(textoCierre(porInactividad, AHORA, ZONA), "Se cerrará mañana a las 1:39 a.m. si no se usa");

  const porLimite = vidaDeSesion(fila({ iniciada_en: iso(AHORA - 23 * HORA), ultimo_uso: iso(AHORA - 1 * MIN) }), AHORA);
  assert.equal(textoCierre(porLimite, AHORA, ZONA), "Se cerrará hoy a las 7:09 p.m.");

  const pestana = vidaDeSesion(fila({ pestana_cerrada_en: iso(AHORA - 1 * MIN) }), AHORA);
  assert.equal(textoCierre(pestana, AHORA, ZONA), "Se cerrará a las 6:13 p.m.");
});

/* ---------- Barra «Vida de esta sesión» ---------- */

/* ---------- «¿No reconoces este dispositivo?» (L33) ---------- */

/* ---------- Bloque B: cableado de la página ---------- */

const HTML = read("src/app/features/portal/index.html");
const PORTAL = read("src/app/features/portal/portal.js");
const CONTROLADOR = read("src/app/features/portal/portal.sesiones.js");

test("the list intro states the S4 rules: with «Recordarme», only 30 days without use (L40)", () => {
  assert.match(
    HTML,
    /Sin «Recordarme», una sesión se cierra tras 8 h sin uso o a las 24 h de haber entrado; con «Recordarme», tras 30 días sin uso\./,
  );
});

test("the nucleus and the controller load after sesiones.service.js and confirm-dialog, before portal.js", () => {
  const pos = (ruta) => HTML.indexOf(`src="${ruta}"`);
  const nucleo = pos("/app/features/portal/sesiones.nucleo.js");
  const controlador = pos("/app/features/portal/portal.sesiones.js");
  assert.ok(nucleo > 0 && controlador > nucleo);
  assert.ok(pos("/app/core/auth/sesiones.service.js") < nucleo);
  assert.ok(pos("/app/shared/confirm-dialog/confirm-dialog.js") < controlador);
  assert.ok(controlador < pos("/app/features/portal/portal.js"));
});

test("the sessions block lives in the «Sesiones» subview of «Acceso y seguridad»", () => {
  const inicio = HTML.indexOf('id="seccion-sesiones"');
  assert.notEqual(inicio, -1, "falta la subvista de sesiones");
  const cuenta = HTML.slice(inicio, HTML.indexOf("</section>", inicio));
  assert.match(HTML.slice(HTML.lastIndexOf("<section", inicio), inicio + 200), /data-padre="cuenta"/);
  assert.match(cuenta, /id="sesiones"/);
  assert.match(cuenta, /Sesiones activas/);
  assert.match(cuenta, /Qué significa cada estado/);
  assert.match(cuenta, /Activa ahora<\/span> se está usando en este momento\./);
  assert.match(cuenta, /8 h sin uso/, "la cabecera dice 8 h sin «Recordarme» (corrección de S1)");
  assert.match(PORTAL, /configurarSesionesActivas\(session\)/);
});

test("the controller never writes data as HTML: city and user agent come from outside", () => {
  assert.doesNotMatch(CONTROLADOR, /innerHTML|insertAdjacentHTML|outerHTML/);
});

test("the controller refreshes only with the tab visible, about every minute (L30)", () => {
  assert.match(CONTROLADOR, /visibilityState === "visible"/);
  assert.match(CONTROLADOR, /60 \* 1000/);
});

test("the controller closes through the session RPCs and confirms both one session and the others (L30, L62)", () => {
  assert.match(CONTROLADOR, /rpc\("sesion_cerrar", \{ p_id:/);
  assert.match(CONTROLADOR, /cerrarLasDemasSesiones\(\)/);
  assert.equal((CONTROLADOR.match(/confirmarConTexto\(/g) || []).length, 2);
});

test("the controller shows the S1/L32/L33 texts", () => {
  for (const texto of [
    "No pudimos cargar tus sesiones.",
    "Reintentar",
    "Cerrar esta sesión",
    "Cerrar las demás sesiones",
    "Mostrar más",
  ]) {
    assert.ok(CONTROLADOR.includes(texto), texto);
  }
});

test("the password change closes the others through the database, no longer with scope others (L30)", () => {
  assert.doesNotMatch(PORTAL, /scope: "others"/);
  assert.match(PORTAL, /await cerrarLasDemasSesiones\(\)/);
});

/* ---------- T9: resumen de «Acceso y seguridad» y estilo de la lista (S15, S16, S18, L59) ---------- */

test("each device falls in one of four kinds: computers, phones, tablets or other (L59)", () => {
  assert.equal(claseDispositivo({ sistema: "Windows" }), "computadora");
  assert.equal(claseDispositivo({ sistema: "macOS" }), "computadora");
  assert.equal(claseDispositivo({ sistema: "Linux" }), "computadora");
  assert.equal(claseDispositivo({ sistema: "ChromeOS" }), "computadora");
  assert.equal(claseDispositivo({ sistema: "iOS", modelo: "iPhone" }), "telefono");
  assert.equal(claseDispositivo({ sistema: "Android" }), "telefono");
  assert.equal(claseDispositivo({ sistema: "iOS", modelo: "iPad" }), "tableta");
  assert.equal(claseDispositivo({}), "otro");
  assert.equal(claseDispositivo({ sistema: "PlayStation" }), "otro");
});

test("the summary groups only open sessions by kind, like the mockup (S15, L59)", () => {
  const filas = [
    fila({ sistema: "Windows", modelo: null, ultimo_uso: iso(AHORA - 1 * MIN) }),
    fila({ sistema: "Linux", modelo: null, ultimo_uso: iso(AHORA - 30 * MIN) }),
    fila({ es_actual: true, sistema: "iOS", modelo: "iPhone", ultimo_uso: iso(AHORA - 1 * MIN) }),
    fila({ sistema: "Android", modelo: null, ultimo_uso: iso(AHORA - 2 * HORA) }),
    fila({ sistema: "Windows", modelo: null, cerrada_en: iso(AHORA - DIA), motivo_cierre: "inactividad" }),
  ];
  const resumen = resumirPorTipo(filas, AHORA);
  assert.equal(resumen.total, 4, "las cerradas de los últimos 7 días no cuentan");
  assert.deepEqual(resumen.grupos, [
    { clase: "computadora", titulo: "2 sesiones en computadoras", detalle: "Windows, Linux · 1 activa ahora" },
    { clase: "telefono", titulo: "2 sesiones en teléfonos", detalle: "iPhone (este dispositivo), Android · 1 activa ahora" },
  ]);
});

test("the summary agrees in number, lists each system once and skips what it cannot name", () => {
  const resumen = resumirPorTipo(
    [
      fila({ sistema: "Windows", modelo: null }),
      fila({ sistema: "Windows", modelo: null, es_actual: true }),
      fila({ sistema: "iOS", modelo: "iPad", ultimo_uso: iso(AHORA - 2 * HORA) }),
      fila({ sistema: "Android", modelo: null, ultimo_uso: iso(AHORA - 2 * HORA) }),
      fila({ sistema: null, navegador: null, modelo: null, ultimo_uso: iso(AHORA - 2 * HORA) }),
    ],
    AHORA,
  );
  assert.deepEqual(resumen.grupos, [
    { clase: "computadora", titulo: "2 sesiones en computadoras", detalle: "Windows (este dispositivo) · 2 activas ahora" },
    { clase: "telefono", titulo: "1 sesión en un teléfono", detalle: "Android" },
    { clase: "tableta", titulo: "1 sesión en una tableta", detalle: "iPad" },
    { clase: "otro", titulo: "1 sesión en otro dispositivo", detalle: "" },
  ]);
  assert.equal(resumirPorTipo([fila({ sistema: "macOS", modelo: null })], AHORA).grupos[0].titulo, "1 sesión en una computadora");
  assert.deepEqual(resumirPorTipo([], AHORA), { total: 0, grupos: [] });
  assert.deepEqual(resumirPorTipo(null, AHORA), { total: 0, grupos: [] });
});

test("the summary reads the user agent when a session has no heartbeat yet", () => {
  const sinLatido = fila({ sistema: null, navegador: null, modelo: null });
  const leer = () => ({ navegador: "Chrome", sistema: "Android", modelo: null });
  assert.equal(resumirPorTipo([sinLatido], AHORA, leer).grupos[0].clase, "telefono");
});

test("the unknown-device note under the summary depends on the password (S16)", () => {
  assert.equal(textoNoReconocesResumen(true), "¿No reconoces un dispositivo? Ciérralo y cambia tu contraseña.");
  assert.equal(
    textoNoReconocesResumen(false),
    "¿No reconoces un dispositivo? Ciérralo desde «Administrar todos los dispositivos».",
  );
});

test("a session past its limit that waits for the cron is «Se está cerrando», never a time in the past (L42, L59)", () => {
  const vencida = vidaDeSesion(fila({ iniciada_en: iso(AHORA - 24 * HORA - 2 * MIN), ultimo_uso: iso(AHORA - 1 * MIN) }), AHORA);
  assert.equal(vencida.estado, "cerrandose");
  assert.equal(ETIQUETAS_ESTADO.cerrandose, "Se está cerrando");
  assert.equal(textoCierre(vencida, AHORA, ZONA), "Se cerrará en unos minutos");

  const pestana = vidaDeSesion(fila({ pestana_cerrada_en: iso(AHORA - 6 * MIN), ultimo_uso: iso(AHORA - 7 * MIN) }), AHORA);
  assert.equal(pestana.estado, "cerrandose");
  const enPlazo = vidaDeSesion(fila({ ultimo_uso: iso(AHORA - 7 * HORA) }), AHORA);
  assert.equal(enPlazo.estado, "inactiva", "antes del límite sigue como antes");
});

test("a closing session stays in the list with the others and counts as open, not active", () => {
  const cerrandose = fila({ iniciada_en: iso(AHORA - 25 * HORA), ultimo_uso: iso(AHORA - 1 * MIN), sistema: "Windows", modelo: null });
  const grupos = agruparSesiones([cerrandose], AHORA);
  assert.equal(grupos.otras.length, 1);
  assert.equal(resumirPorTipo([cerrandose], AHORA).grupos[0].detalle, "Windows");
});

test("«Acceso y seguridad» is a summary: sign-in, devices and account (S15, L59)", () => {
  const inicio = HTML.indexOf('id="seccion-cuenta"');
  const cuenta = HTML.slice(inicio, HTML.indexOf("</section>", inicio));
  assert.match(cuenta, /Revisa cómo entras a tu cuenta, desde qué dispositivos y cómo salir de ella\./);
  assert.doesNotMatch(cuenta, /Aquí vas a ver el correo/);
  for (const titulo of ["Inicio de sesión", "Dispositivos con acceso a tu cuenta", "Cuenta"]) {
    assert.match(cuenta, new RegExp(`class="portal__grupo-titulo"[^>]*>${titulo}<`), titulo);
  }
  assert.match(cuenta, /id="dispositivosResumen"/);
  assert.match(cuenta, /href="#sesiones"[\s\S]*?Administrar todos los dispositivos[\s\S]*?id="dispositivosTotal"/);
  assert.match(cuenta, /id="notaNoReconoces"/);
  assert.match(cuenta, /href="#contrasena"[\s\S]*?Al menos 8 caracteres, una letra mayúscula, una letra minúscula y un número\./);
});

test("a Google-only account sees «Inicias sesión con Google» with its link button instead of «Contraseña ›» (S16)", () => {
  const inicio = HTML.indexOf('id="avisoSinContrasena"');
  const aviso = HTML.slice(inicio, HTML.indexOf('id="filaContrasena"', inicio));
  assert.match(aviso, /Inicias sesión con Google/);
  assert.match(aviso, /Tu cuenta todavía no tiene contraseña\. Si quieres crear una, te enviamos un enlace a tu correo\./);
  assert.match(aviso, /id="botonEnlaceContrasena"[^>]*>Enviarme un enlace</);
  assert.match(aviso, /id="avisoSinContrasenaEstado"[^>]*role="status"/);
  assert.match(PORTAL, /filaContrasena[\s\S]{0,80}hidden = !tieneContrasena/);
  // Quien llegue a #contrasena sin contraseña ve a dónde ir, no un título vacío.
  assert.match(HTML, /id="contrasenaSinContrasena" hidden>[^<]*«Enviarme un enlace» en <a href="#cuenta">/);
  assert.match(PORTAL, /contrasenaSinContrasena[\s\S]{0,80}hidden = tieneContrasena/);
});

test("the controller fills the summary from the same list and refreshes while either view is visible", () => {
  assert.match(CONTROLADOR, /resumirPorTipo\(estado\.filas, ahora, dispositivoDeFila\)/);
  assert.match(CONTROLADOR, /textoNoReconocesResumen\(tieneContrasena\)/);
  assert.match(CONTROLADOR, /"No pudimos cargar tus dispositivos\."/);
  assert.match(CONTROLADOR, /seccionResumen/);
});

test("the legend explains «Se está cerrando»", () => {
  assert.match(HTML, /sesiones__insignia--cerrandose">Se está cerrando<\/span> ya llegó a su límite y se cierra en los próximos minutos\./);
  assert.match(read("src/app/features/portal/portal.css"), /\.sesiones__insignia--cerrandose\s*\{/);
});

test("the tables take the modal look: one card with separators between rows (S18)", () => {
  const css = read("src/app/features/portal/portal.css");
  const bloque = css.slice(css.indexOf(".sesiones {"));
  assert.match(bloque, /\.sesiones__tabla-envoltorio\s*\{[^}]*background-color: var\(--cfg-tarjeta\);/);
  assert.match(bloque, /\.sesiones__tabla tbody tr \+ tr td\s*\{\s*border-block-start: 1px solid var\(--cfg-borde\);/);
});

/* ---------- L61: tocar una sesión no hace nada; se cierra desde su fila ---------- */

const FILA_ABIERTA = CONTROLADOR.match(/function filaAbierta[\s\S]*?\n  }\n/)[0];

/* ---------- L62: la lista es una tabla y «⋯» pide confirmación ---------- */

test("full dates look like the attachment: «18 oct 2026, 6:04 a.m.» (L62)", () => {
  assert.equal(fechaCompleta(Date.parse("2026-10-18T12:04:00Z"), ZONA), "18 oct 2026, 6:04 a.m.");
});

test("open sessions are a table: Dispositivo, Ubicación, Creado, Actualizado and «⋯» (L62)", () => {
  const tabla = CONTROLADOR.match(/function tablaSesiones[\s\S]*?\n  }\n/)[0];
  assert.match(tabla, /tabla\(\s*\["Dispositivo", "Ubicación", "Creado", "Actualizado"\],[\s\S]*\{ conAccion: true \}/);
  const envoltorio = CONTROLADOR.match(/function tabla\([\s\S]*?\n  }\n/)[0];
  assert.match(envoltorio, /class: "sesiones__tabla-envoltorio"/);
  assert.match(envoltorio, /conAccion \? el\("th", \{ scope: "col", class: "sesiones__accion", "aria-label": "Acciones" \}\)/);
  assert.match(FILA_ABIERTA, /fechaCompleta\(vida\.iniciadaEn\)/, "Creado");
  assert.match(FILA_ABIERTA, /fechaCompleta\(vida\.ultimoUso\)/, "Actualizado");
  assert.match(FILA_ABIERTA, /textoCierre\(vida, ahora\)/, "«Se cerrará …» bajo Actualizado");
  assert.doesNotMatch(FILA_ABIERTA, /Recordarme/, "«Recordarme» sale de la fila");
});

/* ---------- L66: las cerradas también son una tabla ---------- */

test("closed sessions are a table like the open ones: Dispositivo, Ubicación, Cerrada, Motivo, without «⋯» (L66)", () => {
  const seccion = CONTROLADOR.slice(CONTROLADOR.indexOf("Cerradas en los últimos 7 días"));
  const llamada = seccion.match(/tabla\(\s*\[([^\]]*)\]/);
  assert.ok(llamada, "las cerradas se dibujan con tabla([...])");
  assert.deepEqual(
    [...llamada[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    ["Dispositivo", "Ubicación", "Cerrada", "Motivo"],
  );
  assert.match(seccion.slice(0, 400), /visibles\.map\(\(item\) => filaCerrada\(item\)\)/);
  assert.doesNotMatch(CONTROLADOR, /sesiones__lista|sesiones__item/);
});

test("a closed row is a table row with its date and reason, and tapping it does nothing (L31, L66)", () => {
  const filaCerrada = CONTROLADOR.match(/function filaCerrada[\s\S]*?\n  }\n/)[0];
  assert.match(filaCerrada, /el\(\s*"tr"/);
  assert.match(filaCerrada, /nombreDispositivo\(dispositivoDeFila\(fila\)\)/);
  assert.match(filaCerrada, /textoUbicacion\(fila\)/);
  assert.match(filaCerrada, /fechaCompleta\(fila\.cerrada_en\)/);
  assert.match(filaCerrada, /fraseMotivo\(fila\.motivo_cierre\)/);
  assert.doesNotMatch(filaCerrada, /onclick|button/);
});

test("on a phone the table slides inside its own box; the page never scrolls sideways (L62)", () => {
  const css = read("src/app/features/portal/portal.css");
  assert.match(css, /\.sesiones__tabla-envoltorio\s*\{[^}]*overflow-x: auto;/);
  assert.match(css, /\.sesiones__tabla\s*\{[^}]*min-inline-size: \d+px;/);
  const bloque = css.slice(css.indexOf(".sesiones {"));
  assert.doesNotMatch(bloque, /overflow-wrap: anywhere/);
  assert.match(bloque, /\.sesiones a\s*\{\s*color: var\(--cfg-acento\);/);
});

test("the state badge sits next to the name, and the current session says «Actual» (L62)", () => {
  const celda = FILA_ABIERTA.slice(FILA_ABIERTA.indexOf('class: "sesiones__dispositivo"'));
  assert.match(celda, /fila\.es_actual\s*\?\s*el\("span", \{ class: "sesiones__insignia sesiones__insignia--actual", texto: "Actual" \}\)\s*:\s*insignia\(vida\.estado\)/);
  assert.match(read("src/app/features/portal/portal.css"), /\.sesiones__insignia--actual\s*\{/);
});

test("tapping a row still does nothing: its only control is «⋯», and the current one has none (L61, L62)", () => {
  assert.equal((FILA_ABIERTA.match(/onclick:/g) || []).length, 1);
  assert.match(
    FILA_ABIERTA,
    /fila\.es_actual\s*\?\s*null\s*:\s*el\("button", \{[^)]*?"aria-label": `Cerrar la sesión de \$\{nombre\}`,[^)]*?onclick: \(evento\) => cerrarUna\(fila\.id, evento\.currentTarget\),\s*texto: "⋯",?\s*\}\)/,
  );
  assert.doesNotMatch(CONTROLADOR, /abrirDetalle|dibujarDetalle|sesionesDetalle|Detalle de sesión/);
});

test("«⋯» asks first: «¿Cerrar esta sesión?» with «Cancelar» and «Cerrar sesión», then closes (L62)", () => {
  const cerrar = CONTROLADOR.match(/async function cerrarUna[\s\S]*?\n  }\n/)[0];
  assert.match(cerrar, /titulo: "¿Cerrar esta sesión\?"/);
  assert.match(cerrar, /mensaje: "Ese dispositivo perderá acceso a tu cuenta\."/);
  assert.match(cerrar, /etiquetaConfirmar: "Cerrar sesión"/);
  assert.match(cerrar, /if \(!confirmado\) return;/);
  assert.ok(cerrar.indexOf("confirmarConTexto(") < cerrar.indexOf('rpc("sesion_cerrar"'), "confirma antes de cerrar");
  // La fila cerrada desaparece con su botón: el foco vuelve al título.
  assert.match(cerrar, /if \(cerrada && titulo\) titulo\.focus\(\)/);
});
