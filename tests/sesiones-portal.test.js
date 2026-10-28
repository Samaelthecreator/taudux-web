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
  detalleNavegador,
  tipoDispositivo,
  haceCuanto,
  fechaRelativa,
  fechaCompleta,
  textoCierre,
  textoRecordarme,
  tramosVida,
  textoInactivas,
  ETIQUETAS_ESTADO,
  CERRADAS_POR_PAGINA,
  textoNoReconoces,
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

test("S4 rules: 3 min active, 1 h / 24 h without signal, 8 h / 30 days idle, 24 h / 30 days total, 5 min after the tab closes", () => {
  assert.equal(REGLAS_SESION.activaMs, 3 * MIN);
  assert.deepEqual(REGLAS_SESION.sinRecordarme, { senalMs: HORA, inactividadMs: 8 * HORA, totalMs: 24 * HORA });
  assert.deepEqual(REGLAS_SESION.conRecordarme, { senalMs: 24 * HORA, inactividadMs: 30 * DIA, totalMs: 30 * DIA });
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

test("with «Recordarme»: no signal up to 24 h and the 30-day limit (start never after last use, L20)", () => {
  const inicio = AHORA - 3 * DIA;
  const uso = AHORA - 5 * HORA;
  const vida = vidaDeSesion(fila({ recordarme: true, iniciada_en: iso(inicio), ultimo_uso: iso(uso) }), AHORA);
  assert.equal(vida.estado, "sin-senal");
  assert.equal(vida.inactivaDesde.getTime(), uso + 24 * HORA);
  assert.equal(vida.seCerrara.getTime(), inicio + 30 * DIA);
  assert.equal(vida.causa, "límite");

  const inactiva = vidaDeSesion(fila({ recordarme: true, iniciada_en: iso(inicio), ultimo_uso: iso(AHORA - 2 * DIA) }), AHORA);
  assert.equal(inactiva.estado, "inactiva");
});

test("a tie between idleness and the total limit is the limit: using it would not extend it", () => {
  const vida = vidaDeSesion(fila({ recordarme: true, iniciada_en: iso(AHORA - HORA), ultimo_uso: iso(AHORA - HORA) }), AHORA);
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
  const inicio = AHORA - 30 * DIA + 2 * HORA;
  const vida = vidaDeSesion(fila({ recordarme: true, iniciada_en: iso(inicio), ultimo_uso: iso(AHORA - 5 * HORA) }), AHORA);
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

test("device names read «Browser en System»; iOS uses the model", () => {
  assert.equal(nombreDispositivo({ navegador: "Safari", sistema: "iOS", modelo: "iPhone" }), "Safari en iPhone");
  assert.equal(nombreDispositivo({ navegador: "Edge", sistema: "Android", modelo: "SM-S918B" }), "Edge en Android");
  assert.equal(nombreDispositivo({ navegador: "Chrome", sistema: "Windows" }), "Chrome en Windows");
  assert.equal(nombreDispositivo({ navegador: null, sistema: "Linux" }), "Linux");
  assert.equal(nombreDispositivo({ navegador: "Firefox", sistema: null }), "Firefox");
  assert.equal(nombreDispositivo({}), "Dispositivo desconocido");
});

test("the browser row carries real versions: «Edge 130 · Android 15»", () => {
  assert.equal(
    detalleNavegador({ navegador: "Edge", navegador_version: "130", sistema: "Android", sistema_version: "15" }),
    "Edge 130 · Android 15"
  );
  assert.equal(detalleNavegador({ navegador: "Firefox", navegador_version: "131", sistema: "Windows" }), "Firefox 131 · Windows");
  assert.equal(detalleNavegador({}), "Desconocido");
});

test("phones and tablets get the mobile icon, everything else the computer", () => {
  assert.equal(tipoDispositivo({ sistema: "iOS" }), "movil");
  assert.equal(tipoDispositivo({ sistema: "Android" }), "movil");
  assert.equal(tipoDispositivo({ sistema: "Windows" }), "computadora");
  assert.equal(tipoDispositivo({}), "computadora");
});

/* ---------- Fechas ---------- */

test("«Último uso: hace …»", () => {
  assert.equal(haceCuanto(AHORA - 20 * 1000, AHORA), "hace un momento");
  assert.equal(haceCuanto(AHORA - 25 * MIN, AHORA), "hace 25 min");
  assert.equal(haceCuanto(AHORA - 3 * HORA, AHORA), "hace 3 h");
  assert.equal(haceCuanto(AHORA - 1 * DIA, AHORA), "hace 1 día");
  assert.equal(haceCuanto(AHORA - 4 * DIA, AHORA), "hace 4 días");
});

test("relative dates: today, tomorrow, yesterday, or day and month, in the given time zone", () => {
  assert.equal(fechaRelativa(AHORA + 2 * MIN, AHORA, ZONA), "hoy a las 6:11 p.m.");
  assert.equal(fechaRelativa(AHORA + 8 * HORA, AHORA, ZONA), "mañana a las 2:09 a.m.");
  assert.equal(fechaRelativa(AHORA - 20 * HORA, AHORA, ZONA), "ayer a las 10:09 p.m.");
  assert.equal(fechaRelativa(AHORA + 10 * DIA, AHORA, ZONA), "el 6 nov a las 6:09 p.m.");
});

test("full dates look like the mockup: «18 oct 2026, 6:04 a.m.»", () => {
  assert.equal(fechaCompleta(Date.parse("2026-10-18T12:04:00Z"), ZONA), "18 oct 2026, 6:04 a.m.");
});

test("closing text: «si no se usa» only when idleness closes it; a closed tab says «a las HH:MM»", () => {
  const porInactividad = vidaDeSesion(fila({ ultimo_uso: iso(AHORA - 30 * MIN) }), AHORA);
  assert.equal(textoCierre(porInactividad, AHORA, ZONA), "Se cerrará mañana a las 1:39 a.m. si no se usa");

  const porLimite = vidaDeSesion(fila({ iniciada_en: iso(AHORA - 23 * HORA), ultimo_uso: iso(AHORA - 1 * MIN) }), AHORA);
  assert.equal(textoCierre(porLimite, AHORA, ZONA), "Se cerrará hoy a las 7:09 p.m.");

  const pestana = vidaDeSesion(fila({ pestana_cerrada_en: iso(AHORA - 1 * MIN) }), AHORA);
  assert.equal(textoCierre(pestana, AHORA, ZONA), "Se cerrará a las 6:13 p.m.");
});

test("the «Recordarme» row states its rule (S1 corrections)", () => {
  assert.equal(textoRecordarme(false), "No · se cierra a las 8 h sin uso");
  assert.equal(textoRecordarme(true), "Sí · se cierra a los 30 días");
});

/* ---------- Barra «Vida de esta sesión» ---------- */

test("the life bar has three stretches and places «Ahora» inside the current one", () => {
  const uso = AHORA - 30 * MIN;
  const vida = vidaDeSesion(fila({ ultimo_uso: iso(uso) }), AHORA);
  const barra = tramosVida(vida, AHORA);
  assert.deepEqual(barra.tramos.map((t) => t.clave), ["activa", "sin-senal", "inactiva"]);
  assert.equal(barra.tramos[1].desde.getTime(), uso + 3 * MIN);
  assert.equal(barra.tramos[2].desde.getTime(), uso + HORA);
  assert.equal(barra.tramos[2].hasta.getTime(), uso + 8 * HORA);
  assert.ok(barra.posicionAhora > 1 / 3 && barra.posicionAhora < 2 / 3, String(barra.posicionAhora));
});

test("without an idle stretch the bar has two parts and «Ahora» stays within 0..1", () => {
  const inicio = AHORA - 30 * DIA + 2 * HORA;
  const vida = vidaDeSesion(fila({ recordarme: true, iniciada_en: iso(inicio), ultimo_uso: iso(AHORA - 5 * HORA) }), AHORA);
  const barra = tramosVida(vida, AHORA);
  assert.deepEqual(barra.tramos.map((t) => t.clave), ["activa", "sin-senal"]);
  assert.ok(barra.posicionAhora >= 0 && barra.posicionAhora <= 1);
});

/* ---------- «¿No reconoces este dispositivo?» (L33) ---------- */

test("the unknown-device hint depends on whether the account has a password", () => {
  assert.deepEqual(textoNoReconoces(true), {
    texto: "¿No reconoces este dispositivo? Ciérrala y ",
    enlace: "cambia tu contraseña",
    final: ".",
  });
  assert.deepEqual(textoNoReconoces(false), {
    texto: "¿No reconoces este dispositivo? Ciérrala y revisa la seguridad de tu cuenta de Google.",
    enlace: null,
    final: "",
  });
});

/* ---------- Bloque B: cableado de la página ---------- */

const HTML = read("src/app/features/portal/index.html");
const PORTAL = read("src/app/features/portal/portal.js");
const CONTROLADOR = read("src/app/features/portal/portal.sesiones.js");

test("the nucleus and the controller load after sesiones.service.js and confirm-dialog, before portal.js", () => {
  const pos = (ruta) => HTML.indexOf(`src="${ruta}"`);
  const nucleo = pos("/app/features/portal/sesiones.nucleo.js");
  const controlador = pos("/app/features/portal/portal.sesiones.js");
  assert.ok(nucleo > 0 && controlador > nucleo);
  assert.ok(pos("/app/core/auth/sesiones.service.js") < nucleo);
  assert.ok(pos("/app/shared/confirm-dialog/confirm-dialog.js") < controlador);
  assert.ok(controlador < pos("/app/features/portal/portal.js"));
});

test("the sessions block lives inside «Acceso y seguridad»", () => {
  const cuenta = HTML.slice(HTML.indexOf('id="seccion-cuenta"'), HTML.indexOf('id="seccion-correo"'));
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

test("the controller closes through the session RPCs and confirms only «Cerrar las demás» (L30)", () => {
  assert.match(CONTROLADOR, /rpc\("sesion_cerrar", \{ p_id:/);
  assert.match(CONTROLADOR, /cerrarLasDemasSesiones\(\)/);
  assert.equal((CONTROLADOR.match(/confirmarConTexto\(/g) || []).length, 1);
});

test("the controller shows the S1/L32/L33 texts", () => {
  for (const texto of [
    "Esa sesión ya se cerró",
    "No pudimos cargar tus sesiones.",
    "Reintentar",
    "Para salir de este dispositivo usa «Cerrar sesión»",
    "Cerrar esta sesión",
    "Cerrar las demás sesiones",
    "Mostrar más",
    "Si este dispositivo se vuelve a usar antes, pasa a activa y la cuenta empieza de nuevo.",
  ]) {
    assert.ok(CONTROLADOR.includes(texto), texto);
  }
});

test("the password change closes the others through the database, no longer with scope others (L30)", () => {
  assert.doesNotMatch(PORTAL, /scope: "others"/);
  assert.match(PORTAL, /await cerrarLasDemasSesiones\(\)/);
});
