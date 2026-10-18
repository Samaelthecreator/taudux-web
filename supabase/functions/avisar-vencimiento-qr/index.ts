// avisar-vencimiento-qr: el aviso por correo de que un QR vence mañana. Un
// correo por QR, al creador, entre 23 y 24 h antes del vencimiento.
//
// La llama pg_cron (0054) cada hora. La autoriza SÓLO la cabecera
// x-taudux-qr-secret, comparada en tiempo constante contra QR_CRON_SECRET (el
// mismo secreto que revisar-qr); el Authorization que manda pg_cron es la anon
// key pública y no autoriza nada.
//
// Qué QR toca lo decide la base (qr_avisos_vencimiento_pendientes, 0053). Cada
// QR se marca con el vencimiento que se avisó SÓLO después de que Resend aceptó
// el lote: si Resend falla no se marca nada y la corrida de la hora siguiente
// lo reintenta. Si falla el marcado, el peor caso es un correo repetido.

import { enviarEmail } from "../_shared/enviarEmail.ts";
import { paraEmail } from "../_shared/plantillas/qrPorVencer.ts";

// El límite del endpoint batch de Resend: un solo lote por corrida. Lo que no
// alcance sale en la siguiente (la base ordena por vencimiento más próximo).
export const LOTE = 100;

function constantTimeEquals(a, b) {
  const left = String(a ?? "");
  const right = String(b ?? "");
  const length = Math.max(left.length, right.length);
  let diff = left.length === right.length ? 0 : 1;
  for (let index = 0; index < length; index++) {
    const leftCode = index < left.length ? left.charCodeAt(index) : 0;
    const rightCode = index < right.length ? right.charCodeAt(index) : 0;
    diff |= leftCode ^ rightCode;
  }
  return diff === 0;
}

export function createAvisarVencimientoQrHandler(overrides = {}) {
  const dependencies = {
    getEnv: (name) => globalThis.Deno?.env?.get(name),
    fetchImpl: globalThis.fetch?.bind(globalThis),
    createServiceClient: createSupabaseServiceClient,
    logger: globalThis.console,
    now: () => globalThis.performance?.now?.() ?? Date.now(),
    // La hora de pared (now() es un reloj para medir duraciones).
    ahora: () => new Date(),
    ...overrides,
  };

  return async function handleAvisarVencimientoQr(request) {
    const started = dependencies.now();
    const finish = (status, code, payload) => {
      const event = {
        event: "avisar_vencimiento_qr",
        code,
        status,
        durationMs: Math.max(0, Math.round(dependencies.now() - started)),
        ...(payload?.ok ? payload : {}),
      };
      dependencies.logger[status >= 400 ? "error" : "info"](JSON.stringify(event));
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    };

    try {
      if (request.method !== "POST") {
        return finish(405, "method_not_allowed", { ok: false, code: "method_not_allowed" });
      }
      const secreto = dependencies.getEnv("QR_CRON_SECRET");
      if (typeof secreto !== "string" || secreto.length === 0 ||
          !constantTimeEquals(request.headers.get("x-taudux-qr-secret"), secreto)) {
        return finish(401, "unauthorized", { ok: false, code: "unauthorized" });
      }

      const resendApiKey = dependencies.getEnv("RESEND_API_KEY");
      const remitente = dependencies.getEnv("CORREO_REMITENTE");
      const siteUrl = dependencies.getEnv("SITE_URL");
      const projectUrl = dependencies.getEnv("SUPABASE_URL");
      const serviceRole = dependencies.getEnv("SUPABASE_SERVICE_ROLE_KEY");
      if (!resendApiKey || !remitente || !siteUrl) {
        return finish(503, "correo_sin_configurar", { ok: false, code: "correo_sin_configurar" });
      }
      if (!projectUrl || !serviceRole) return finish(500, "internal_error", { ok: false, code: "internal_error" });

      const service = await dependencies.createServiceClient({ projectUrl, serviceRole });
      const { data: pendientes, error } = await service.rpc("qr_avisos_vencimiento_pendientes", { p_limite: LOTE });
      if (error || !Array.isArray(pendientes)) {
        return finish(503, "no_disponible", { ok: false, code: "no_disponible" });
      }

      const resumen = { ok: true, pendientes: pendientes.length, enviados: 0, errores: 0 };
      if (pendientes.length === 0) return finish(200, "sin_pendientes", resumen);

      const ahora = dependencies.ahora();
      const mensajes = pendientes.map((qr) => paraEmail({
        ahora,
        qr,
        destinatario: { email: qr.email },
        siteUrl: siteUrl.replace(/\/+$/, ""),
        remitente,
      }));
      const envio = await enviarEmail(dependencies, resendApiKey, mensajes);
      if (!envio.ok) {
        return finish(502, "envio_fallido", { ok: false, code: "envio_fallido", reason: envio.reason });
      }
      resumen.enviados = pendientes.length;

      for (const { id, vence_en: venceEn } of pendientes) {
        const { error: errorMarca } = await service.rpc("qr_marcar_aviso_vencimiento", {
          p_id: id,
          p_vence_en: venceEn,
        });
        if (errorMarca) resumen.errores++;
      }
      return finish(200, "avisos_enviados", resumen);
    } catch {
      return finish(500, "internal_error", { ok: false, code: "internal_error" });
    }
  };
}

async function createSupabaseServiceClient({ projectUrl, serviceRole }) {
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(projectUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

// Keep platform JWT verification enabled: pg_cron sends the public anon key as
// Authorization only to satisfy it. Authorization for this function is the
// x-taudux-qr-secret header alone, compared in constant time.
if (globalThis.Deno && typeof globalThis.Deno.serve === "function") {
  globalThis.Deno.serve(createAvisarVencimientoQrHandler());
}
