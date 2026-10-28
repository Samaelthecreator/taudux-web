/*
  Ciudad aproximada de quien llama, para «Sesiones activas» (S2).

  Vercel ya calcula la ubicación por IP y la pone en cabeceras de la petición
  (https://vercel.com/docs/headers/request-headers): esta función sólo la
  devuelve, sin terceros nuevos. La IP nunca sale de acá (S5). El latido
  (src/app/core/auth/sesiones.service.js) la pide al iniciar la sesión y una
  vez al día, y la guarda con `sesion_latido`.

  CommonJS a propósito: el proyecto raíz no tiene package.json, así que Node
  trata este archivo como CommonJS. En Live Server no existe y el latido sigue
  sin ciudad.
*/

// Vercel codifica la ciudad para URL («Le%C3%B3n»). La base acota a 100.
function leerCabecera(cabeceras, nombre) {
  const valor = cabeceras?.[nombre];
  if (typeof valor !== "string") return null;
  try {
    const decodificado = decodeURIComponent(valor).trim();
    return decodificado ? decodificado.slice(0, 100) : null;
  } catch {
    return null;
  }
}

module.exports = function ubicacion(req, res) {
  // La respuesta depende de quién llama: ninguna caché puede guardarla.
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.end();
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify({
      ciudad: leerCabecera(req.headers, "x-vercel-ip-city"),
      region: leerCabecera(req.headers, "x-vercel-ip-country-region"),
      pais: leerCabecera(req.headers, "x-vercel-ip-country"),
    })
  );
};
