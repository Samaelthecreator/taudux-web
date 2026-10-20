const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const FUNCTION_PATH = path.resolve("supabase/functions/avisar-vencimiento-qr/index.ts");
const endpoint = import(pathToFileURL(FUNCTION_PATH).href);
const SECRETO = "secreto-del-cron";

// 20:30 UTC = 14:30 en la Ciudad de México (UTC-6, sin horario de verano).
const PENDIENTES = [
  { id: 1, codigo: "abc234", titulo: "Menú del café", vence_en: "2026-10-18T20:30:00Z", email: "uno@example.com" },
  { id: 2, codigo: "xyz789", titulo: null, vence_en: "2026-10-18T21:00:00Z", email: "dos@example.com" },
];

function pedido(options = {}) {
  // Object.hasOwn y no un default: `secreto: undefined` tiene que significar
  // "sin cabecera", no "el secreto correcto".
  const secreto = Object.hasOwn(options, "secreto") ? options.secreto : SECRETO;
  const method = options.method ?? "POST";
  const headers = { authorization: "Bearer anon" };
  if (secreto !== undefined) headers["x-taudux-qr-secret"] = secreto;
  return new Request("https://edge.test/avisar-vencimiento-qr", { method, headers });
}

async function harness(options = {}) {
  const { createAvisarVencimientoQrHandler } = await endpoint;
  const calls = { rpc: [], resend: [] };
  const env = {
    QR_CRON_SECRET: SECRETO,
    RESEND_API_KEY: "re_clave",
    CORREO_REMITENTE: "Taudux <avisos@taudux.com>",
    SITE_URL: "https://taudux.com",
    SUPABASE_URL: "https://yqkvgfqplmbbcebrivpt.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    ...options.env,
  };
  const handler = createAvisarVencimientoQrHandler({
    getEnv: (name) => env[name],
    now: () => 0,
    // 15:00 del 17 de octubre en la Ciudad de México.
    ahora: () => new Date("2026-10-17T21:00:00Z"),
    createServiceClient: async () => ({
      async rpc(name, args) {
        calls.rpc.push({ name, args });
        if (name === "qr_avisos_vencimiento_pendientes") {
          return options.pendientesError
            ? { data: null, error: { message: "boom" } }
            : { data: options.pendientes ?? PENDIENTES, error: null };
        }
        if (name === "qr_marcar_aviso_vencimiento") {
          return options.marcarError ? { data: null, error: { message: "boom" } } : { data: true, error: null };
        }
        throw new Error(`rpc inesperado ${name}`);
      },
    }),
    fetchImpl: async (url, init) => {
      calls.resend.push({ url, init, mensajes: JSON.parse(init.body) });
      return new Response("{}", { status: options.resendStatus ?? 200 });
    },
    logger: { info() {}, error() {} },
  });
  return { handler, calls };
}

const marcados = (calls) => calls.rpc.filter((call) => call.name === "qr_marcar_aviso_vencimiento").map((call) => call.args);

test("only the cron secret authorizes sending expiry notices", async () => {
  const { handler, calls } = await harness();
  for (const secreto of [undefined, "", "otro", `${SECRETO}x`]) {
    assert.equal((await handler(pedido({ secreto }))).status, 401, `secreto ${JSON.stringify(secreto)}`);
  }
  assert.equal((await handler(pedido({ method: "GET" }))).status, 405);
  assert.deepEqual(calls.rpc, []);
  assert.deepEqual(calls.resend, []);

  const sinSecreto = await harness({ env: { QR_CRON_SECRET: "" } });
  assert.equal((await sinSecreto.handler(pedido({ secreto: "" }))).status, 401);
});

test("each QR about to expire gets one email to its creator, then is marked as notified", async () => {
  const { handler, calls } = await harness();
  const response = await handler(pedido());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, pendientes: 2, enviados: 2, errores: 0 });

  assert.equal(calls.resend.length, 1, "un solo lote a Resend");
  const { url, init, mensajes } = calls.resend[0];
  assert.equal(url, "https://api.resend.com/emails/batch");
  assert.equal(init.headers.Authorization, "Bearer re_clave");
  assert.equal(mensajes.length, 2, "un correo por QR");

  const [conNombre, sinNombre] = mensajes;
  assert.equal(conNombre.from, "Taudux <avisos@taudux.com>");
  assert.deepEqual(conNombre.to, ["uno@example.com"]);
  assert.equal(conNombre.subject, "Tu QR «Menú del café» vence mañana");
  assert.match(conNombre.text, /vence el domingo 18 de octubre a las 14:30/);
  assert.match(conNombre.text, /14:30/, "la hora va en la de la Ciudad de México");
  assert.match(conNombre.text, /go\.taudux\.com\/abc234/);
  assert.match(conNombre.text, /https:\/\/taudux\.com\/app\/features\/qr\//, "enlace para crear otro");
  assert.match(conNombre.html, /https:\/\/taudux\.com\/app\/features\/qr\//);
  assert.equal(conNombre.headers, undefined, "sin List-Unsubscribe: es un aviso de servicio sin baja");

  assert.deepEqual(sinNombre.to, ["dos@example.com"]);
  assert.equal(sinNombre.subject, "Tu QR go.taudux.com/xyz789 vence mañana", "sin nombre, el link corto");

  assert.deepEqual(marcados(calls), [
    { p_id: 1, p_vence_en: "2026-10-18T20:30:00Z" },
    { p_id: 2, p_vence_en: "2026-10-18T21:00:00Z" },
  ], "se marca con el vencimiento avisado, para que un cambio de vencimiento rearme el aviso");
});

test("the subject says today when the QR expires before midnight in Mexico City", async () => {
  // 05:00 UTC del 18 = 23:00 del 17 en la Ciudad de México: vence HOY.
  const { handler, calls } = await harness({ pendientes: [{ ...PENDIENTES[0], vence_en: "2026-10-18T05:00:00Z" }] });
  await handler(pedido());
  const { subject, text } = calls.resend[0].mensajes[0];
  assert.equal(subject, "Tu QR «Menú del café» vence hoy");
  assert.match(text, /vence hoy sábado 17 de octubre a las 23:00/);
});

test("the copy speaks to the user in tuteo, not voseo", async () => {
  const { handler, calls } = await harness();
  await handler(pedido());
  const { text, html } = calls.resend[0].mensajes[0];
  for (const cuerpo of [text, html]) {
    assert.match(cuerpo, /puedes/);
    assert.doesNotMatch(cuerpo, /\b(podés|creá|tenés|querés|entrá)\b/);
  }
});

test("a name typed by the user is escaped in the HTML body", async () => {
  const { handler, calls } = await harness({
    pendientes: [{ ...PENDIENTES[0], titulo: '<script>alert("x")</script> & co' }],
  });
  await handler(pedido());
  const { html, text } = calls.resend[0].mensajes[0];
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; co/);
  assert.match(text, /<script>alert\("x"\)<\/script> & co/, "el texto plano va tal cual");
});

test("control characters in a name never reach the subject line", async () => {
  // 0044/0052 sólo recortan los extremos: un pedido armado a mano puede guardar
  // saltos de línea adentro, y un asunto con CR/LF podría hacer que Resend
  // rechace el lote ENTERO (los avisos de todos).
  const { handler, calls } = await harness({
    pendientes: [{ ...PENDIENTES[0], titulo: "Menú\r\nBcc: x@y.z\tdel café" }],
  });
  await handler(pedido());
  const { subject, text } = calls.resend[0].mensajes[0];
  assert.equal(subject, "Tu QR «Menú Bcc: x@y.z del café» vence mañana");
  assert.doesNotMatch(text.split("\n\n")[0], /[\r\t]/);
});

test("when Resend fails nothing is marked, so the next hourly run retries", async () => {
  const { handler, calls } = await harness({ resendStatus: 500 });
  const response = await handler(pedido());
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, "envio_fallido");
  assert.deepEqual(marcados(calls), []);
});

test("with nothing about to expire, Resend is not called", async () => {
  const { handler, calls } = await harness({ pendientes: [] });
  const response = await handler(pedido());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, pendientes: 0, enviados: 0, errores: 0 });
  assert.deepEqual(calls.resend, []);
});

test("missing email configuration or an unavailable database stops before sending", async () => {
  for (const faltante of ["RESEND_API_KEY", "CORREO_REMITENTE", "SITE_URL"]) {
    const { handler, calls } = await harness({ env: { [faltante]: "" } });
    const response = await handler(pedido());
    assert.equal(response.status, 503, faltante);
    assert.equal((await response.json()).code, "correo_sin_configurar");
    assert.deepEqual(calls.rpc, [], `${faltante}: no consulta la base`);
  }

  const { handler, calls } = await harness({ pendientesError: true });
  assert.equal((await handler(pedido())).status, 503);
  assert.deepEqual(calls.resend, []);
});

test("a failed mark is counted but does not fail the run", async () => {
  const { handler } = await harness({ marcarError: true });
  const response = await handler(pedido());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, pendientes: 2, enviados: 2, errores: 2 });
});
