/*
  Núcleo puro del portal de cuenta: el catálogo de secciones y la resolución de
  cuál está activa según el hash de la URL. Sin DOM y sin efectos, así que Node
  puede requerirlo en los tests igual que el borrador del formulario de curso.

  Una sección con `disponible: false` sigue siendo un destino válido: la página
  existe y explica qué falta, no se esconde. Lo que nunca vale es un hash
  desconocido — ahí se cae a la primera sección en vez de dejar el portal vacío.

  Una sección con `padre` es una subvista: tiene su propio hash, no aparece en
  el menú y, mientras está abierta, el menú marca a su padre.
*/

const SECCIONES_PORTAL = [
  { id: "perfil", etiqueta: "Editar perfil", disponible: true },
  { id: "cuenta", etiqueta: "Acceso y seguridad", disponible: true },
  { id: "contrasena", etiqueta: "Contraseña", disponible: true, padre: "cuenta" },
  { id: "sesiones", etiqueta: "Sesiones activas", disponible: true, padre: "cuenta" },
  { id: "correo", etiqueta: "Preferencias de avisos", disponible: true },
  { id: "plan", etiqueta: "Mi plan", disponible: false },
  { id: "pagos", etiqueta: "Pagos", disponible: false },
];

function normalizarHash(hash) {
  if (typeof hash !== "string") return "";
  return hash.replace(/^#/, "").trim();
}

/*
  Nunca devuelve undefined: el portal siempre tiene una sección visible. Un hash
  basura (`#<script>`) no matchea ningún id y cae en la primera sección, que es
  también el destino de una carga sin hash.
*/
function resolverSeccionActiva(hash, secciones = SECCIONES_PORTAL) {
  const disponibles = Array.isArray(secciones) && secciones.length > 0 ? secciones : SECCIONES_PORTAL;
  const candidato = normalizarHash(hash);
  const encontrada = disponibles.find((seccion) => seccion.id === candidato);
  return encontrada ? encontrada.id : disponibles[0].id;
}

// La entrada del menú que queda marcada: la del padre si `id` es una subvista.
function seccionDelMenu(id, secciones = SECCIONES_PORTAL) {
  const resuelta = resolverSeccionActiva(id, secciones);
  const seccion = secciones.find((candidata) => candidata.id === resuelta);
  return (seccion && seccion.padre) || resuelta;
}

/*
  El `href` de un enlace que navega dentro del panel: sólo un hash desnudo de
  una sección conocida. Todo lo demás (`/#contacto`, un hash que no existe) es
  un enlace normal y el navegador lo sigue como siempre.
*/
function hashDeEnlaceInterno(href, secciones = SECCIONES_PORTAL) {
  if (typeof href !== "string" || !href.startsWith("#")) return null;
  const id = normalizarHash(href);
  return secciones.some((seccion) => seccion.id === id) ? `#${id}` : null;
}

/*
  A dónde lleva la ✕: a la página del sitio de la que vino, salvo que sea una
  pantalla de acceso (volver al login sería volver a entrar) o el propio
  portal. Sin referrer útil —abierto desde un correo, otro sitio o Google— va
  al inicio.
*/
function destinoAlCerrar(referrer, origen) {
  let url;
  try {
    url = new URL(referrer);
  } catch {
    return "/";
  }
  if (url.origin !== origen) return "/";
  if (/^\/app\/features\/(auth|portal)(\/|$)/.test(url.pathname)) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

/*
  En la capa «Configuración» (iframe con ?embebido=1), un enlace que lleva a
  otra página tiene que abrirse arriba: adentro del iframe quedaría un sitio
  dentro del sitio, y el login ni siquiera se deja enmarcar. Sólo un cambio
  de hash se queda en el panel.
*/
function enlaceSaleDelPanel(href, actual) {
  let destino;
  let aqui;
  try {
    aqui = new URL(actual);
    destino = new URL(href, aqui);
  } catch {
    return false;
  }
  return (
    destino.origin !== aqui.origin ||
    destino.pathname !== aqui.pathname ||
    destino.search !== aqui.search
  );
}

if (typeof module === "object" && module.exports) {
  module.exports = Object.freeze({
    SECCIONES_PORTAL,
    resolverSeccionActiva,
    seccionDelMenu,
    hashDeEnlaceInterno,
    destinoAlCerrar,
    enlaceSaleDelPanel,
  });
}
