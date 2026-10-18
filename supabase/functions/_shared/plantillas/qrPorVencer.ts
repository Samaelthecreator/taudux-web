// plantilla qrPorVencer: el "QUÉ dice" del aviso de que un QR vence mañana.
// Recibe el QR y su creador y devuelve el mensaje para Resend; no sabe
// enviar nada (eso es enviarEmail.ts). Un correo por QR.
//
// Diferencias a propósito con nuevoCurso.ts:
// - El nombre del QR lo escribe el usuario, así que va escapado en el HTML
//   (el título de un curso lo pone un admin).
// - Sin List-Unsubscribe: es un aviso de servicio sobre algo que la persona
//   creó, no un boletín, y no hay baja que ofrecer (decisión del 2026-10-17).
// Se conserva el cuerpo en texto plano: es lo que lo saca de la carpeta de spam.

// El mismo dominio de los links cortos que src/app/features/qr/qr.nucleo.js.
const QR_BASE = "go.taudux.com";
const ZONA = "America/Mexico_City";

const fecha = new Intl.DateTimeFormat("es-MX", { weekday: "long", day: "numeric", month: "long", timeZone: ZONA });
const hora = new Intl.DateTimeFormat("es-MX", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: ZONA });
// Sólo para comparar días en la zona de México ("2026-10-17").
const dia = new Intl.DateTimeFormat("en-CA", { timeZone: ZONA });

function escaparHtml(texto) {
  return String(texto)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// `ahora` decide "hoy" o "mañana": el aviso sale entre 23 y 24 h antes, así que
// casi siempre es mañana, pero un QR que vence antes de medianoche (o la primera
// corrida tras desplegar) vence hoy.
export function paraEmail({ qr, destinatario, siteUrl, remitente, ahora = new Date() }) {
  const link = `${QR_BASE}/${qr.codigo}`;
  const nuevoUrl = `${siteUrl}/app/features/qr/`;
  const vence = new Date(qr.vence_en);
  const hoy = dia.format(vence) === dia.format(ahora);
  // "domingo 18 de octubre": sin la coma que Intl pone tras el día de la semana.
  const cuando = `${hoy ? "hoy" : "el"} ${fecha.format(vence).replace(",", "")} a las ${hora.format(vence)} ` +
    `(hora del centro de México)`;
  // El nombre sólo se recorta en los extremos al guardarse (0044/0052): uno con
  // saltos de línea adentro rompería el asunto, y Resend podría rechazar el lote
  // entero. Cada tramo de caracteres de control queda en un espacio.
  const titulo = String(qr.titulo ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim() || null;
  const nombre = titulo ? `«${titulo}»` : link;
  const nombreHtml = titulo ? `«${escaparHtml(titulo)}» (${link})` : link;

  return {
    from: remitente,
    to: [destinatario.email],
    subject: `Tu QR ${nombre} vence ${hoy ? "hoy" : "mañana"}`,
    text: `Tu QR ${titulo ? `${nombre} (${link})` : link} vence ${cuando}.\n\n` +
      `Después de esa hora, quien lo escanee verá un aviso de que ya no funciona. ` +
      `Un QR no se puede renovar, pero puedes crear uno nuevo aquí: ${nuevoUrl}\n\n` +
      `Te escribimos porque creaste este QR en Taudux.`,
    html: `<p>Tu QR <strong>${nombreHtml}</strong> vence ${cuando}.</p>` +
      `<p>Después de esa hora, quien lo escanee verá un aviso de que ya no funciona. ` +
      `Un QR no se puede renovar, pero puedes crear uno nuevo.</p>` +
      `<p><a href="${nuevoUrl}">Crear un QR nuevo</a></p>` +
      `<p style="font-size:12px;color:#666;">Te escribimos porque creaste este QR en Taudux.</p>`,
  };
}
