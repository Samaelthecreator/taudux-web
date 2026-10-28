/*
  Latido de sesión: le dice a la base que esta sesión se sigue usando.

  Las migraciones 0055–0057 cuentan con él. «Último uso» es el último latido
  (0056), así que sin este archivo la limpieza de pg_cron cerraría toda sesión
  sin «Recordarme» a las 8 h aunque la persona siguiera ahí. Y al revés: si la
  sesión se cerró en otro lado, el latido responde `false` y esta pestaña sale.

  Cuándo late (L25):
  - al cargar cada página (el sitio es multipágina: la siguiente borra la marca
    de «pestaña cerrada» que dejó la anterior al irse);
  - cada 60 s, pero sólo con la pestaña visible: una pestaña olvidada pasa a
    «Sin señal» y se cierra a las 8 h;
  - al volver a la pestaña, y al volver de la caché atrás/adelante.

  Al cerrar la pestaña sin «Recordarme» avisa con `fetch(..., { keepalive })`:
  la base la cierra a los 5 min si nadie vuelve a latir. Si la pestaña estuvo
  oculta más que la vida del JWT, el token ya venció y el aviso se rechaza; se
  aceptó así (L26): esa sesión se cierra a las 8 h, como cualquier olvidada.

  Pestañas duplicadas comparten sesión (se copia el sessionStorage). Por eso el
  aviso también viaja por BroadcastChannel: la otra pestaña de la misma sesión
  late a los pocos segundos aunque esté oculta, y borra la marca (L26).

  Depende de supabase-client.js y auth.service.js; va antes de navbar.js.
*/

const LATIDO_INTERVALO_MS = 60 * 1000;
const UBICACION_VIGENCIA_MS = 24 * 60 * 60 * 1000;
const LLAVE_UBICACION = "taudux_ubicacion";
const CANAL_SESIONES = "taudux_sesiones";
// La otra pestaña espera para que su latido llegue DESPUÉS del aviso de la que
// se cerró; si llegara antes, la marca quedaría puesta y la sesión moriría.
const DEMORA_LATIDO_HERMANA_MS = 5000;

const NOMBRES_NAVEGADOR = Object.freeze({
  "Microsoft Edge": "Edge",
  "Google Chrome": "Chrome",
  Opera: "Opera",
  Brave: "Brave",
  "Samsung Internet": "Samsung Internet",
  YaBrowser: "Yandex",
});

const NOMBRES_SISTEMA = Object.freeze({
  "Chrome OS": "ChromeOS",
  "Chromium OS": "ChromeOS",
});

function versionMayor(version) {
  const mayor = String(version || "").split(".")[0];
  return /^\d+$/.test(mayor) ? mayor : null;
}

// Windows sólo se distingue por Client Hints: platformVersion 13+ es Windows 11,
// 1–10 es Windows 10 (https://learn.microsoft.com/microsoft-edge/web-platform/how-to-detect-win11).
function versionDeSistema(plataforma, platformVersion) {
  const mayor = versionMayor(platformVersion);
  if (plataforma !== "Windows") return mayor;
  if (mayor === null) return null;
  const numero = Number(mayor);
  if (numero >= 13) return "11";
  if (numero >= 1) return "10";
  return null;
}

function dispositivoDesdeHints(hints) {
  const marcas = (hints.fullVersionList || hints.brands || []).filter(
    (marca) => marca && marca.brand && !/not.?a.?brand/i.test(marca.brand)
  );
  // «Chromium» aparece junto a la marca real; sólo vale si es la única.
  const marca = marcas.find((m) => m.brand !== "Chromium") || marcas[0];
  if (!marca || !hints.platform) return null;

  return {
    navegador: NOMBRES_NAVEGADOR[marca.brand] || marca.brand,
    navegador_version: versionMayor(marca.version),
    sistema: NOMBRES_SISTEMA[hints.platform] || hints.platform,
    sistema_version: versionDeSistema(hints.platform, hints.platformVersion),
    modelo: hints.model ? String(hints.model) : null,
  };
}

function navegadorDesdeUserAgent(ua) {
  const reglas = [
    ["Edge", /(?:Edg|EdgA|EdgiOS)\/(\d+)/],
    ["Opera", /(?:OPR|OPiOS)\/(\d+)/],
    ["Samsung Internet", /SamsungBrowser\/(\d+)/],
    ["Firefox", /(?:Firefox|FxiOS)\/(\d+)/],
    ["Chrome", /(?:Chrome|CriOS)\/(\d+)/],
    ["Safari", /Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//],
  ];
  for (const [nombre, patron] of reglas) {
    const coincidencia = ua.match(patron);
    if (coincidencia) return { navegador: nombre, navegador_version: coincidencia[1] };
  }
  return { navegador: null, navegador_version: null };
}

function sistemaDesdeUserAgent(ua) {
  const ios = ua.match(/(iPhone|iPad|iPod).*? OS (\d+)_/);
  if (ios) return { sistema: "iOS", sistema_version: ios[2], modelo: ios[1] };
  // Chrome y Edge en Android congelan la versión en «Android 10»: sin Client
  // Hints no hay forma de saber la real, así que se guarda lo que dice (S13).
  const android = ua.match(/Android (\d+)/);
  if (android) return { sistema: "Android", sistema_version: android[1], modelo: null };
  // «Windows NT 10.0» lo dicen Windows 10 y 11 por igual: versión desconocida.
  if (/Windows/.test(ua)) return { sistema: "Windows", sistema_version: null, modelo: null };
  if (/CrOS/.test(ua)) return { sistema: "ChromeOS", sistema_version: null, modelo: null };
  if (/Mac OS X|Macintosh/.test(ua)) return { sistema: "macOS", sistema_version: null, modelo: null };
  if (/Linux/.test(ua)) return { sistema: "Linux", sistema_version: null, modelo: null };
  return { sistema: null, sistema_version: null, modelo: null };
}

/*
  Navegador y sistema para «Detalle de sesión», p. ej. «Edge 130 · Android 15».
  Con Client Hints se usa la versión real; sin ellos (Safari, Firefox) lo que
  diga el user agent (S13). La base acota cada campo a 60 caracteres.
*/
function dispositivoDesde(userAgent, hints) {
  const desdeHints = hints ? dispositivoDesdeHints(hints) : null;
  if (desdeHints) return desdeHints;

  const ua = String(userAgent || "");
  return { ...navegadorDesdeUserAgent(ua), ...sistemaDesdeUserAgent(ua) };
}

async function dispositivoActual() {
  let hints = null;
  try {
    if (navigator.userAgentData?.getHighEntropyValues) {
      hints = await navigator.userAgentData.getHighEntropyValues([
        "platformVersion",
        "fullVersionList",
        "model",
      ]);
    }
  } catch {
    // Sin Client Hints se usa el user agent.
  }
  return dispositivoDesde(navigator.userAgent, hints);
}

// El JWT viaja en base64url: `atob` no acepta «-» ni «_» y pide relleno (L12).
function sesionIdDe(accessToken) {
  try {
    const payload = String(accessToken).split(".")[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const relleno = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(relleno)).session_id || null;
  } catch {
    return null;
  }
}

function leerMarcaUbicacion() {
  try {
    return JSON.parse(localStorage.getItem(LLAVE_UBICACION));
  } catch {
    return null;
  }
}

function ubicacionVigente(sessionId) {
  const marca = leerMarcaUbicacion();
  return Boolean(
    marca &&
      marca.session_id === sessionId &&
      Date.now() - marca.en < UBICACION_VIGENCIA_MS
  );
}

/*
  Ciudad que Vercel calcula por IP (S2). Se pide en el primer latido de la
  sesión y después una vez al día (L26); la base conserva la última ciudad no
  nula, así que los latidos de en medio la mandan vacía. La marca la escribe
  latir() sólo cuando la base guardó el latido: en Live Server no hay /api, y
  si la llamada o el latido fallan la página siguiente lo vuelve a intentar.
*/
async function ubicacionSiToca(sessionId) {
  if (!sessionId || ubicacionVigente(sessionId)) return null;
  try {
    const respuesta = await fetch("/api/ubicacion");
    if (!respuesta.ok) return null;
    return await respuesta.json();
  } catch {
    return null;
  }
}

function marcarUbicacion(sessionId) {
  try {
    localStorage.setItem(
      LLAVE_UBICACION,
      JSON.stringify({ session_id: sessionId, en: Date.now() })
    );
  } catch {
    // Storage bloqueado: se volverá a pedir en la página siguiente.
  }
}

const estadoLatido = {
  token: null,
  sessionId: null,
  intervalo: null,
  dispositivoEnviado: false,
  cerrando: false,
  canal: null,
};

function recordarToken(sesion) {
  estadoLatido.token = sesion?.access_token ?? null;
  estadoLatido.sessionId = sesionIdDe(estadoLatido.token);
}

/*
  ¿La sesión local desapareció sin que nadie la cerrara desde esta página?

  Pasa con una pestaña oculta más que la vida del JWT cuya sesión se cerró
  mientras tanto: al volver, supabase-js no puede renovar el token, borra la
  sesión local en silencio y las llamadas siguientes viajan con la clave
  anónima. `sesion_latido` es sólo para `authenticated`, así que respondería
  un error, no `false`, y la persona quedaría fuera sin aviso. Un error de
  getSession (sin red) no cuenta: la sesión puede seguir viva.
*/
async function sesionVigente() {
  let resultado;
  try {
    resultado = await supabaseClient.auth.getSession();
  } catch {
    return { fallo: true, sesion: null };
  }
  if (resultado?.error) return { fallo: true, sesion: null };
  return { fallo: false, sesion: resultado?.data?.session ?? null };
}

async function latir() {
  if (estadoLatido.cerrando) return;

  const { fallo, sesion } = await sesionVigente();
  if (fallo) return;
  if (!sesion) {
    // Un cierre pedido desde esta página (menú, portal, eliminar la cuenta)
    // ya decide a dónde ir; no se le cruza el login.
    if (!cierreDeSesionSolicitado) await salirPorSesionCerrada();
    return;
  }
  recordarToken(sesion);

  const conDispositivo = !estadoLatido.dispositivoEnviado;
  const dispositivo = conDispositivo ? await dispositivoActual() : null;
  const ubicacion = await ubicacionSiToca(estadoLatido.sessionId);

  let respuesta;
  try {
    respuesta = await supabaseClient.rpc("sesion_latido", {
      // Siempre un booleano: nulo se guardaría como «sin Recordarme» (A6).
      p_recordarme: recordarme(),
      p_ciudad: ubicacion?.ciudad ?? null,
      p_region: ubicacion?.region ?? null,
      p_pais: ubicacion?.pais ?? null,
      p_dispositivo: dispositivo,
    });
  } catch {
    // Sin red: el próximo latido lo intenta de nuevo.
    return;
  }

  // Un error (red, o el front desplegado antes que la 0055) no saca a nadie y
  // deja dispositivo y ubicación para el próximo latido.
  if (respuesta?.error) return;

  // Sólo un `false` explícito significa «la sesión ya no existe». Si fue esta
  // página la que la cerró (sesion_salir ya pasó), ella decide a dónde ir.
  if (respuesta?.data === false) {
    if (!cierreDeSesionSolicitado) await salirPorSesionCerrada();
    return;
  }
  if (respuesta?.data !== true) return;
  if (conDispositivo) estadoLatido.dispositivoEnviado = true;
  if (ubicacion) marcarUbicacion(estadoLatido.sessionId);
}

/*
  La sesión se cerró en otro lado (otro dispositivo, la limpieza, el
  administrador). Se limpia lo local y se manda al login con el aviso y el
  camino de vuelta (S9, L25).
*/
async function salirPorSesionCerrada() {
  if (estadoLatido.cerrando) return;
  estadoLatido.cerrando = true;
  if (estadoLatido.intervalo !== null) clearInterval(estadoLatido.intervalo);

  try {
    await cerrarSesion({ scope: "local" });
  } catch {
    // Se limpia a mano abajo.
  }
  // La sesión ya no existe en la base: aunque supabase-js no haya podido
  // borrarla, el token guardado no sirve y no debe quedarse.
  for (const almacen of [window.localStorage, window.sessionStorage]) {
    try {
      almacen.removeItem(LLAVE_SESION);
    } catch {
      // Storage bloqueado: no hay nada que borrar.
    }
  }

  const { pathname, search, hash } = window.location;
  const destino = `${pathname}${search}${hash}`;
  guardarDestinoAuth(destino);
  const login = urlLoginConDestino(destino);
  window.location.href = `${login}${login.includes("?") ? "&" : "?"}sesion=cerrada`;
}

function avisarPestanaCerrada() {
  if (recordarme() || !estadoLatido.token || estadoLatido.cerrando) return;

  try {
    fetch(`${SUPABASE_URL}/rest/v1/rpc/sesion_pestana_cerrada`, {
      method: "POST",
      keepalive: true,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${estadoLatido.token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    }).catch(() => {});
  } catch {
    // La pestaña se está yendo: no hay a quién avisar del error.
  }

  try {
    estadoLatido.canal?.postMessage({
      tipo: "pestana-cerrada",
      session_id: estadoLatido.sessionId,
    });
  } catch {
    // Sin canal: la otra pestaña latirá cuando vuelva a estar visible.
  }
}

function escucharPestanasHermanas() {
  if (typeof BroadcastChannel !== "function") return;
  try {
    estadoLatido.canal = new BroadcastChannel(CANAL_SESIONES);
  } catch {
    return;
  }
  estadoLatido.canal.onmessage = (evento) => {
    const datos = evento?.data;
    if (
      datos?.tipo === "pestana-cerrada" &&
      estadoLatido.sessionId &&
      datos.session_id === estadoLatido.sessionId
    ) {
      setTimeout(latir, DEMORA_LATIDO_HERMANA_MS);
    }
  };
}

async function iniciarLatido() {
  // Los slides corren en un iframe dentro de /slides: late la página que los
  // contiene. Las pantallas de auth están a mitad de un login.
  if (window.top !== window) return;
  if (window.location.pathname.startsWith("/app/features/auth/")) return;

  // Había un token guardado y supabase-js no lo pudo renovar: la sesión se
  // cerró mientras la pestaña o el navegador estaban cerrados.
  let habiaToken = false;
  try {
    habiaToken = Boolean(almacenElegido().getItem(LLAVE_SESION));
  } catch {
    // Storage bloqueado: no hay sesión guardada.
  }

  const { fallo, sesion } = await sesionVigente();
  if (fallo) return;
  if (!sesion) {
    if (habiaToken) await salirPorSesionCerrada();
    return;
  }
  recordarToken(sesion);

  supabaseClient.auth.onAuthStateChange((_evento, nueva) => {
    if (nueva) recordarToken(nueva);
  });

  escucharPestanasHermanas();
  estadoLatido.intervalo = setInterval(() => {
    if (document.visibilityState === "visible") return latir();
    return undefined;
  }, LATIDO_INTERVALO_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") return latir();
    return undefined;
  });
  window.addEventListener("pageshow", (evento) => {
    if (evento?.persisted) return latir();
    return undefined;
  });
  window.addEventListener("pagehide", avisarPestanaCerrada);

  await latir();
}

document.addEventListener("DOMContentLoaded", iniciarLatido);
