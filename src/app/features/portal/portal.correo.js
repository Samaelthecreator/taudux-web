/*
  Núcleo puro de "Preferencias de avisos": normalización y diff del
  interruptor de aviso de curso nuevo. Sin DOM y sin fetch, igual que
  portal.perfil.js — Node lo puede requerir directo en los tests.

  El cableado (pintar el interruptor, mostrar errores, llamar al service)
  vive en portal.js.
*/

// undefined/null (fila de la BD sin el dato, o perfil aún no cargado) se
// normalizan a false: sin preferencia guardada, no se avisa.
function normalizarPreferenciasCorreo({ avisosCursoNuevo } = {}) {
  return { avisosCursoNuevo: Boolean(avisosCursoNuevo) };
}

/*
  Devuelve ya el nombre de columna de la BD (avisos_curso_nuevo), para que el
  resultado sea paso directo al service, igual que camposModificados de
  portal.perfil.js. {} si el interruptor coincide con lo guardado.
*/
function cambiosPreferenciasCorreo(original, actual) {
  const base = normalizarPreferenciasCorreo(original);
  const nuevo = normalizarPreferenciasCorreo(actual);

  if (base.avisosCursoNuevo === nuevo.avisosCursoNuevo) return {};
  return { avisos_curso_nuevo: nuevo.avisosCursoNuevo };
}

/*
  El interruptor (S17) guarda al tocarlo: pide el valor contrario al guardado
  y devuelve lo que hay que mostrar. Si falla (o lanza), lo de antes, así el
  interruptor regresa a como estaba; si sale bien, lo que quedó en la BD.
*/
async function alternarPreferenciaCorreo(guardado, guardar) {
  const antes = normalizarPreferenciasCorreo(guardado);
  const pedido = { avisosCursoNuevo: !antes.avisosCursoNuevo };
  let resultado;
  try {
    resultado = await guardar(cambiosPreferenciasCorreo(antes, pedido));
  } catch {
    // Sin conexión, la llamada lanza en vez de devolver { ok: false }.
    resultado = { ok: false, mensaje: "No se pudieron guardar los cambios." };
  }
  if (!resultado.ok) return { ok: false, preferencias: antes, mensaje: resultado.mensaje };
  const guardadoAhora = resultado.data ? resultado.data.avisos_curso_nuevo : pedido.avisosCursoNuevo;
  return { ok: true, preferencias: normalizarPreferenciasCorreo({ avisosCursoNuevo: guardadoAhora }) };
}

if (typeof module === "object" && module.exports) {
  module.exports = Object.freeze({
    normalizarPreferenciasCorreo,
    cambiosPreferenciasCorreo,
    alternarPreferenciaCorreo,
  });
}
