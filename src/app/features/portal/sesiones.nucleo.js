/*
  Núcleo puro de «Sesiones activas» (T5 de sesiones-activas): estados, plazos,
  orden y textos de la lista. Sin DOM y sin red, así que Node lo
  requiere en los tests igual que portal.secciones.js.

  Las filas son las de `sesiones_listar()` (0055:216). Los plazos copian los de
  la limpieza de pg_cron (0056:99-101) para que «Se cerrará» diga lo mismo que
  hará la base: «La sesión se cierra con el límite que llegue primero.» (S4).
  La limpieza corre cada 5 min, así que el cierre real puede llegar hasta 5 min
  después de la hora que se muestra (L19).
*/

const MINUTO_MS = 60 * 1000;
const HORA_MS = 60 * MINUTO_MS;
const DIA_MS = 24 * HORA_MS;

const REGLAS_SESION = Object.freeze({
  activaMs: 3 * MINUTO_MS,
  sinRecordarme: Object.freeze({ senalMs: HORA_MS, inactividadMs: 8 * HORA_MS, totalMs: 24 * HORA_MS }),
  // Con «Recordarme» no hay límite total: mientras se use, nunca se cierra (L40).
  conRecordarme: Object.freeze({ senalMs: 24 * HORA_MS, inactividadMs: 30 * DIA_MS, totalMs: Infinity }),
  pestanaCerradaMs: 5 * MINUTO_MS,
});

const ETIQUETAS_ESTADO = Object.freeze({
  activa: "Activa ahora",
  "sin-senal": "Sin señal",
  inactiva: "Inactiva",
  "pestana-cerrada": "Pestaña cerrada",
  cerrandose: "Se está cerrando",
});

// Orden dentro de «Otras sesiones»: lo que se usa ahora primero (S1).
const RANGO_ESTADO = Object.freeze({ activa: 0, "sin-senal": 1, "pestana-cerrada": 2, cerrandose: 3, inactiva: 4 });

const CERRADAS_POR_PAGINA = 10;

const FRASES_MOTIVO = Object.freeze({
  "cerrada por ti": "Cerrada por ti",
  "cerraste sesión": "Cerraste sesión",
  inactividad: "Por inactividad",
  "límite": "Llegó a su límite de tiempo",
  "pestaña cerrada": "Se cerró la pestaña",
  "sesión terminada": "Terminó la sesión",
  "cambio de sistema": "Cierre general por actualización",
});

function aMs(valor) {
  if (valor instanceof Date) return valor.getTime();
  if (typeof valor === "number") return valor;
  const ms = Date.parse(valor);
  return Number.isNaN(ms) ? null : ms;
}

/*
  Vida de una sesión abierta: en qué estado está y cuándo se cierra. Una sesión
  sin fila de presencia trae `recordarme` nulo y se rige por las reglas sin
  «Recordarme» (L19). La marca de pestaña cerrada sólo cuenta sin «Recordarme»,
  como en 0056, y nunca en la sesión actual: esta pestaña está abierta.
*/
function vidaDeSesion(fila, ahora) {
  const recordarme = fila.recordarme === true;
  const reglas = recordarme ? REGLAS_SESION.conRecordarme : REGLAS_SESION.sinRecordarme;
  const uso = aMs(fila.ultimo_uso) ?? ahora;
  const inicio = aMs(fila.iniciada_en) ?? uso;
  const pestana = !recordarme && !fila.es_actual ? aMs(fila.pestana_cerrada_en) : null;

  // Empate: gana el primero. El límite va antes porque usar la sesión no lo
  // mueve, así que «si no se usa» sería falso (0056 no define el empate).
  const candidatos = [
    { ms: inicio + reglas.totalMs, causa: "límite" },
    { ms: uso + reglas.inactividadMs, causa: "inactividad" },
  ];
  if (pestana !== null) candidatos.push({ ms: pestana + REGLAS_SESION.pestanaCerradaMs, causa: "pestaña cerrada" });
  const cierre = candidatos.reduce((menor, c) => (c.ms < menor.ms ? c : menor));

  const inactivaMs = uso + reglas.senalMs;
  const inactivaDesde = inactivaMs < cierre.ms ? new Date(inactivaMs) : null;

  // Ya pasó su límite y espera a la limpieza de pg_cron (hasta 5 min): no se
  // muestra una hora que ya pasó (L42, L59).
  let estado;
  if (ahora >= cierre.ms) estado = "cerrandose";
  else if (pestana !== null) estado = "pestana-cerrada";
  else if (ahora - uso < REGLAS_SESION.activaMs) estado = "activa";
  else if (inactivaDesde === null || ahora < inactivaMs) estado = "sin-senal";
  else estado = "inactiva";

  return {
    estado,
    recordarme,
    ultimoUso: new Date(uso),
    iniciadaEn: new Date(inicio),
    inactivaDesde,
    seCerrara: new Date(cierre.ms),
    causa: cierre.causa,
  };
}

function agruparSesiones(filas, ahora) {
  const abiertas = [];
  const cerradas = [];
  for (const fila of Array.isArray(filas) ? filas : []) {
    if (fila.cerrada_en) cerradas.push({ fila });
    else abiertas.push({ fila, vida: vidaDeSesion(fila, ahora) });
  }

  const actual = abiertas.find((s) => s.fila.es_actual) || null;
  const demas = abiertas
    .filter((s) => s !== actual)
    .sort(
      (a, b) =>
        RANGO_ESTADO[a.vida.estado] - RANGO_ESTADO[b.vida.estado] ||
        b.vida.ultimoUso.getTime() - a.vida.ultimoUso.getTime()
    );
  cerradas.sort((a, b) => aMs(b.fila.cerrada_en) - aMs(a.fila.cerrada_en));

  return {
    actual,
    otras: demas.filter((s) => s.vida.estado !== "inactiva"),
    inactivas: demas.filter((s) => s.vida.estado === "inactiva"),
    cerradas,
  };
}

function textoInactivas(cantidad) {
  return cantidad === 1 ? "Mostrar 1 sesión inactiva" : `Mostrar ${cantidad} sesiones inactivas`;
}

function fraseMotivo(motivo) {
  return FRASES_MOTIVO[motivo] || "Sesión cerrada";
}

/*
  «Ciudad, País» (L30). La región de Vercel es un código ISO 3166-2 («GUA»), no
  un nombre (A4 de L28), así que no se muestra.
*/
function nombrePais(codigo) {
  try {
    return new Intl.DisplayNames("es", { type: "region" }).of(codigo) || codigo;
  } catch {
    return codigo;
  }
}

function textoUbicacion({ ciudad, pais } = {}) {
  const partes = [];
  if (ciudad) partes.push(String(ciudad));
  if (pais) partes.push(nombrePais(String(pais).toUpperCase()));
  return partes.length > 0 ? partes.join(", ") : "Ubicación desconocida";
}

// En iOS el equipo dice más que el sistema: «iPhone», «iPad».
function equipoDe({ sistema, modelo } = {}) {
  return sistema === "iOS" && /^(iPhone|iPad|iPod)$/.test(modelo || "") ? modelo : sistema;
}

function nombreDispositivo({ navegador, sistema, modelo } = {}) {
  const equipo = equipoDe({ sistema, modelo });
  if (navegador && equipo) return `${navegador} en ${equipo}`;
  return navegador || equipo || "Dispositivo desconocido";
}

function tipoDispositivo({ sistema } = {}) {
  return sistema === "iOS" || sistema === "Android" ? "movil" : "computadora";
}

/*
  Tipo para el resumen de «Acceso y seguridad» (L59). Una tableta Android y un
  iPad con iPadOS 13+ (que se presenta como Mac) no se distinguen por el user
  agent: caen en teléfonos y computadoras.
*/
const SISTEMAS_COMPUTADORA = Object.freeze(["Windows", "macOS", "Linux", "ChromeOS"]);

function claseDispositivo({ sistema, modelo } = {}) {
  if (sistema === "iOS") return modelo === "iPad" ? "tableta" : "telefono";
  if (sistema === "Android") return "telefono";
  return SISTEMAS_COMPUTADORA.includes(sistema) ? "computadora" : "otro";
}

const NOMBRES_CLASE = Object.freeze({
  computadora: Object.freeze(["una computadora", "computadoras"]),
  telefono: Object.freeze(["un teléfono", "teléfonos"]),
  tableta: Object.freeze(["una tableta", "tabletas"]),
  otro: Object.freeze(["otro dispositivo", "otros dispositivos"]),
});

/*
  «Dispositivos con acceso a tu cuenta» (S15): sólo las sesiones abiertas, por
  tipo, con los sistemas sin repetir (el de esta sesión primero y marcado) y
  cuántas están activas ahora, la actual incluida (L59). `leerDispositivo`
  completa una fila sin latido desde su user agent, como hace la lista.
*/
function resumirPorTipo(filas, ahora, leerDispositivo = (fila) => fila) {
  const abiertas = (Array.isArray(filas) ? filas : [])
    .filter((fila) => !fila.cerrada_en)
    .sort((a, b) => Number(Boolean(b.es_actual)) - Number(Boolean(a.es_actual)));

  const porClase = new Map(Object.keys(NOMBRES_CLASE).map((clase) => [clase, null]));
  for (const fila of abiertas) {
    const dispositivo = leerDispositivo(fila) || {};
    const clase = claseDispositivo(dispositivo);
    const grupo = porClase.get(clase) || { cantidad: 0, activas: 0, sistemas: new Map() };
    grupo.cantidad += 1;
    if (vidaDeSesion(fila, ahora).estado === "activa") grupo.activas += 1;
    const equipo = equipoDe(dispositivo);
    if (equipo && !grupo.sistemas.has(equipo)) {
      grupo.sistemas.set(equipo, fila.es_actual ? `${equipo} (este dispositivo)` : equipo);
    }
    porClase.set(clase, grupo);
  }

  const grupos = [];
  for (const [clase, grupo] of porClase) {
    if (!grupo) continue;
    const [singular, plural] = NOMBRES_CLASE[clase];
    const activas = grupo.activas === 1 ? "1 activa ahora" : `${grupo.activas} activas ahora`;
    grupos.push({
      clase,
      titulo: grupo.cantidad === 1 ? `1 sesión en ${singular}` : `${grupo.cantidad} sesiones en ${plural}`,
      detalle: [[...grupo.sistemas.values()].join(", "), grupo.activas > 0 ? activas : ""].filter(Boolean).join(" · "),
    });
  }
  return { total: abiertas.length, grupos };
}

// Intl separa «p.m.» con un espacio angosto (U+202F); se normaliza a uno común.
function formatear(ms, opciones, zona) {
  return new Intl.DateTimeFormat("es-MX", { ...opciones, timeZone: zona })
    .format(new Date(ms))
    .replace(/\s/g, " ");
}

function hora(ms, zona) {
  return formatear(ms, { hour: "numeric", minute: "2-digit" }, zona);
}

// Días de calendario entre dos instantes, contados en la zona indicada. en-CA
// da «2026-10-27», que Date.parse lee sin ambigüedad.
function diferenciaDias(ms, ahora, zona) {
  const formato = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: zona });
  const dia = (valor) => Date.parse(formato.format(new Date(valor)));
  return Math.round((dia(ms) - dia(ahora)) / DIA_MS);
}

function fechaRelativa(fecha, ahora, zona) {
  const ms = aMs(fecha);
  const dias = diferenciaDias(ms, ahora, zona);
  if (dias === 0) return `hoy a las ${hora(ms, zona)}`;
  if (dias === 1) return `mañana a las ${hora(ms, zona)}`;
  if (dias === -1) return `ayer a las ${hora(ms, zona)}`;
  return `el ${formatear(ms, { day: "numeric", month: "short" }, zona)} a las ${hora(ms, zona)}`;
}

// «Creado» y «Actualizado» de la tabla de sesiones (L62): «18 oct 2026, 6:04 a.m.».
function fechaCompleta(fecha, zona) {
  return formatear(aMs(fecha), { dateStyle: "medium", timeStyle: "short" }, zona);
}

/*
  «si no se usa» sólo cuando lo que la cierra es la inactividad: el límite total
  llega aunque se use. La pestaña cerrada dice la hora, sin más (L32).
*/
function textoCierre(vida, ahora, zona) {
  if (vida.estado === "cerrandose") return "Se cerrará en unos minutos";
  const ms = vida.seCerrara.getTime();
  if (vida.causa === "pestaña cerrada" && diferenciaDias(ms, ahora, zona) === 0) {
    return `Se cerrará a las ${hora(ms, zona)}`;
  }
  const cuando = fechaRelativa(ms, ahora, zona);
  return vida.causa === "inactividad" ? `Se cerrará ${cuando} si no se usa` : `Se cerrará ${cuando}`;
}

// La nota bajo el resumen de dispositivos (S15, S16).
function textoNoReconocesResumen(tieneContrasena) {
  return tieneContrasena
    ? "¿No reconoces un dispositivo? Ciérralo y cambia tu contraseña."
    : "¿No reconoces un dispositivo? Ciérralo desde «Administrar todos los dispositivos».";
}

if (typeof module === "object" && module.exports) {
  module.exports = Object.freeze({
    REGLAS_SESION,
    ETIQUETAS_ESTADO,
    CERRADAS_POR_PAGINA,
    vidaDeSesion,
    agruparSesiones,
    textoInactivas,
    fraseMotivo,
    textoUbicacion,
    nombreDispositivo,
    tipoDispositivo,
    claseDispositivo,
    resumirPorTipo,
    fechaRelativa,
    fechaCompleta,
    textoCierre,
    textoNoReconocesResumen,
  });
}
