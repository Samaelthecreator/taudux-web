const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

const {
  SECCIONES_PORTAL,
  resolverSeccionActiva,
  seccionDelMenu,
  hashDeEnlaceInterno,
  destinoAlCerrar,
} = require(path.join(ROOT, "src/app/features/portal/portal.secciones.js"));

const {
  normalizarPerfil,
  validarPerfil,
  validarCambios,
  camposModificados,
  cambiosDeTarjeta,
} = require(path.join(ROOT, "src/app/features/portal/portal.perfil.js"));

const {
  normalizarPreferenciasCorreo,
  cambiosPreferenciasCorreo,
  alternarPreferenciaCorreo,
} = require(path.join(ROOT, "src/app/features/portal/portal.correo.js"));

/* Bloque A — núcleo puro. */

test("the portal section catalog exposes unique, non-empty ids", () => {
  assert.ok(SECCIONES_PORTAL.length > 0);
  const ids = SECCIONES_PORTAL.map((seccion) => seccion.id);
  ids.forEach((id) => {
    assert.equal(typeof id, "string");
    assert.notEqual(id.trim(), "");
  });
  assert.equal(new Set(ids).size, ids.length);
  SECCIONES_PORTAL.forEach((seccion) => {
    assert.equal(typeof seccion.etiqueta, "string");
    assert.notEqual(seccion.etiqueta.trim(), "");
    assert.equal(typeof seccion.disponible, "boolean");
  });
});

test("the active section resolves from a hash with or without the leading marker", () => {
  assert.equal(resolverSeccionActiva("#cuenta"), "cuenta");
  assert.equal(resolverSeccionActiva("cuenta"), "cuenta");
  assert.equal(resolverSeccionActiva("#perfil"), "perfil");
});

test("a missing or empty hash falls back to the first section", () => {
  const primera = SECCIONES_PORTAL[0].id;
  assert.equal(primera, "perfil");
  assert.equal(resolverSeccionActiva(""), primera);
  assert.equal(resolverSeccionActiva(undefined), primera);
  assert.equal(resolverSeccionActiva(null), primera);
  assert.equal(resolverSeccionActiva("#"), primera);
});

test("an unknown or hostile hash never resolves to undefined", () => {
  const primera = SECCIONES_PORTAL[0].id;
  assert.equal(resolverSeccionActiva("#<script>"), primera);
  assert.equal(resolverSeccionActiva("#no-existe"), primera);
  assert.equal(resolverSeccionActiva("#../perfil"), primera);
  assert.equal(resolverSeccionActiva(42), primera);
});

test("an unavailable section is still a valid destination", () => {
  /*
    "Pronto" no significa "no existe": la sección se abre y explica qué falta.
    Redirigir a perfil dejaría al usuario sin entender por qué su clic no hizo
    nada.
  */
  const pagos = SECCIONES_PORTAL.find((seccion) => seccion.id === "pagos");
  assert.equal(pagos.disponible, false);
  assert.equal(resolverSeccionActiva("#pagos"), "pagos");
  assert.equal(resolverSeccionActiva("#plan"), "plan");
  assert.equal(resolverSeccionActiva("#correo"), "correo");
});

/* Bloque A-bis — panel «Configuración» (S14, L45): subvistas, ✕ y historial. */

test("Contraseña and Sesiones are subviews of «Acceso y seguridad» reachable by their own hash", () => {
  ["contrasena", "sesiones"].forEach((id) => {
    const subvista = SECCIONES_PORTAL.find((seccion) => seccion.id === id);
    assert.ok(subvista, `falta la subvista ${id}`);
    assert.equal(subvista.padre, "cuenta");
    assert.equal(subvista.disponible, true);
    assert.equal(resolverSeccionActiva(`#${id}`), id);
  });
});

test("a subview marks its parent in the menu; a top-level section marks itself", () => {
  assert.equal(seccionDelMenu("contrasena"), "cuenta");
  assert.equal(seccionDelMenu("sesiones"), "cuenta");
  assert.equal(seccionDelMenu("perfil"), "perfil");
  assert.equal(seccionDelMenu("cuenta"), "cuenta");
  assert.equal(seccionDelMenu("no-existe"), "perfil", "un id desconocido cae en la primera sección");
});

test("only a bare hash of a known section counts as in-panel navigation", () => {
  assert.equal(hashDeEnlaceInterno("#sesiones"), "#sesiones");
  assert.equal(hashDeEnlaceInterno("#cuenta"), "#cuenta");
  assert.equal(hashDeEnlaceInterno("#no-existe"), null);
  assert.equal(hashDeEnlaceInterno("/#contacto"), null, "Contáctanos sale del portal");
  assert.equal(hashDeEnlaceInterno("#"), null);
  assert.equal(hashDeEnlaceInterno(null), null);
});

test("the ✕ goes back to the previous page of the site, never to the login or the portal", () => {
  const origen = "https://taudux.com";
  assert.equal(destinoAlCerrar("https://taudux.com/app/features/courses/cursos?c=2#x", origen), "/app/features/courses/cursos?c=2#x");
  assert.equal(destinoAlCerrar("https://taudux.com/", origen), "/");
  assert.equal(destinoAlCerrar("https://taudux.com/app/features/auth/login/?next=x", origen), "/");
  assert.equal(destinoAlCerrar("https://taudux.com/app/features/auth/oauth-callback/", origen), "/");
  assert.equal(destinoAlCerrar("https://taudux.com/app/features/portal/#cuenta", origen), "/");
  assert.equal(destinoAlCerrar("https://accounts.google.com/o/oauth2", origen), "/");
  assert.equal(destinoAlCerrar("", origen), "/");
  assert.equal(destinoAlCerrar("no es una url", origen), "/");
});

/* Bloque B — núcleo puro del formulario "Editar Perfil". */

test("normalizarPerfil trims the three fields and turns null/undefined into empty strings", () => {
  assert.deepEqual(
    normalizarPerfil({ nombre: "  Ana  ", apellidos: "  Pérez ", telefono: " +525512345678 " }),
    { nombre: "Ana", apellidos: "Pérez", telefono: "+525512345678" }
  );
  assert.deepEqual(
    normalizarPerfil({ nombre: null, apellidos: undefined, telefono: null }),
    { nombre: "", apellidos: "", telefono: "" }
  );
  assert.deepEqual(normalizarPerfil(), { nombre: "", apellidos: "", telefono: "" });
});

test("validarPerfil rejects an empty name", () => {
  const resultado = validarPerfil({ nombre: "  ", apellidos: "Pérez", telefono: "" });
  assert.equal(resultado.ok, false);
  assert.equal(resultado.campo, "nombre");
});

test("validarPerfil rejects empty surnames", () => {
  const resultado = validarPerfil({ nombre: "Ana", apellidos: "   ", telefono: "" });
  assert.equal(resultado.ok, false);
  assert.equal(resultado.campo, "apellidos");
});

test("validarPerfil rejects a name past the code-point limit", () => {
  const resultado = validarPerfil({
    nombre: "a".repeat(121),
    apellidos: "Pérez",
    telefono: "",
  });
  assert.equal(resultado.ok, false);
  assert.equal(resultado.campo, "nombre");
});

test("validarPerfil rejects a phone number with letters", () => {
  const resultado = validarPerfil({ nombre: "Ana", apellidos: "Pérez", telefono: "+52abc12345" });
  assert.equal(resultado.ok, false);
  assert.equal(resultado.campo, "telefono");
});

test("the invalid phone error talks about the number alone: the country picker already sets the code (L59)", () => {
  const resultado = validarPerfil({ nombre: "Ana", apellidos: "Pérez", telefono: "+52abc12345" });
  assert.equal(resultado.mensaje, "Revisa el número: escribe solo dígitos, sin la lada, por ejemplo 55 1234 5678.");
});

test("validarPerfil rejects a phone number without the leading +", () => {
  const resultado = validarPerfil({ nombre: "Ana", apellidos: "Pérez", telefono: "525512345678" });
  assert.equal(resultado.ok, false);
  assert.equal(resultado.campo, "telefono");
});

test("validarPerfil rejects a phone number that is too short", () => {
  const resultado = validarPerfil({ nombre: "Ana", apellidos: "Pérez", telefono: "+521234" });
  assert.equal(resultado.ok, false);
  assert.equal(resultado.campo, "telefono");
});

test("validarPerfil accepts an empty phone number: it is optional", () => {
  const resultado = validarPerfil({ nombre: "Ana", apellidos: "Pérez", telefono: "" });
  assert.equal(resultado.ok, true);
});

test("validarPerfil accepts a well-formed E.164 phone number", () => {
  const resultado = validarPerfil({ nombre: "Ana", apellidos: "Pérez", telefono: "+525512345678" });
  assert.equal(resultado.ok, true);
});

test("camposModificados returns {} when nothing changed", () => {
  const original = { nombre: "Ana", apellidos: "Pérez", telefono: "+525512345678" };
  const actual = { nombre: "Ana", apellidos: "Pérez", telefono: "+525512345678" };
  assert.deepEqual(camposModificados(original, actual), {});
});

test("camposModificados returns only the field that actually changed", () => {
  const original = { nombre: "Ana", apellidos: "Pérez", telefono: "+525512345678" };
  const actual = { nombre: "Ana", apellidos: "Pérez", telefono: "+525587654321" };
  assert.deepEqual(camposModificados(original, actual), { telefono: "+525587654321" });
});

test("camposModificados treats a null original phone as equivalent to an empty input", () => {
  const original = { nombre: "Ana", apellidos: "Pérez", telefono: null };
  const actual = { nombre: "Ana", apellidos: "Pérez", telefono: "" };
  assert.deepEqual(camposModificados(original, actual), {});
});

test("validarCambios ignores an untouched field even if it holds legacy malformed data", () => {
  // Reproduce el caso real: un teléfono guardado con espacios (dato legacy,
  // nunca producido por el signup actual) no debe bloquear un cambio de nombre.
  const original = { nombre: "Jorge", apellidos: "Estrada", telefono: "+52 4426868988" };
  const actual = { nombre: "Jorge2", apellidos: "Estrada", telefono: "+52 4426868988" };
  const cambios = camposModificados(original, actual);
  assert.deepEqual(cambios, { nombre: "Jorge2" });
  assert.deepEqual(validarCambios(cambios), { ok: true });
});

test("validarCambios still rejects a phone that changed into an invalid value", () => {
  const cambios = { telefono: "+52abc" };
  const resultado = validarCambios(cambios);
  assert.equal(resultado.ok, false);
  assert.equal(resultado.campo, "telefono");
});

test("validarCambios rejects clearing the name to an empty value", () => {
  const cambios = { nombre: "" };
  const resultado = validarCambios(cambios);
  assert.equal(resultado.ok, false);
  assert.equal(resultado.campo, "nombre");
});

/* Bloque B-bis — núcleo puro de "Preferencias de correo". */

test("normalizarPreferenciasCorreo turns null/undefined into false", () => {
  assert.deepEqual(normalizarPreferenciasCorreo({ avisosCursoNuevo: null }), {
    avisosCursoNuevo: false,
  });
  assert.deepEqual(normalizarPreferenciasCorreo({ avisosCursoNuevo: undefined }), {
    avisosCursoNuevo: false,
  });
  assert.deepEqual(normalizarPreferenciasCorreo(), { avisosCursoNuevo: false });
});

test("normalizarPreferenciasCorreo coerces a truthy value to true", () => {
  assert.deepEqual(normalizarPreferenciasCorreo({ avisosCursoNuevo: true }), {
    avisosCursoNuevo: true,
  });
});

test("cambiosPreferenciasCorreo returns {} when the checkbox matches what is saved", () => {
  assert.deepEqual(
    cambiosPreferenciasCorreo({ avisosCursoNuevo: true }, { avisosCursoNuevo: true }),
    {}
  );
  assert.deepEqual(
    cambiosPreferenciasCorreo({ avisosCursoNuevo: null }, { avisosCursoNuevo: false }),
    {}
  );
});

test("cambiosPreferenciasCorreo returns the DB column name when toggled off", () => {
  assert.deepEqual(
    cambiosPreferenciasCorreo({ avisosCursoNuevo: true }, { avisosCursoNuevo: false }),
    { avisos_curso_nuevo: false }
  );
});

test("cambiosPreferenciasCorreo returns the DB column name when toggled on", () => {
  assert.deepEqual(
    cambiosPreferenciasCorreo({ avisosCursoNuevo: false }, { avisosCursoNuevo: true }),
    { avisos_curso_nuevo: true }
  );
});

/* Bloque C — contratos estáticos sobre la fuente. */

test("the portal page stays out of the index", () => {
  const html = read("src/app/features/portal/index.html");
  assert.match(html, /<meta\s+name="robots"\s+content="noindex">/);
});

test("the auth service loads before the portal controller", () => {
  const html = read("src/app/features/portal/index.html");
  const auth = html.indexOf("/app/core/auth/auth.service.js");
  const portal = html.indexOf("/app/features/portal/portal.js");
  assert.notEqual(auth, -1);
  assert.notEqual(portal, -1);
  assert.ok(auth < portal, "auth.service.js debe cargarse antes que portal.js");
});

test("the portal gates on an existing session", () => {
  const js = read("src/app/features/portal/portal.js");
  assert.match(js, /requerirSesion/);
});

test("the portal never reports failures through the global operation channel", () => {
  /*
    reportarFallo emite taudux:operation-error, que navbar.js convierte en un
    toast genérico; sumado a mostrarToast darían dos avisos por un mismo fallo.
  */
  const js = read("src/app/features/portal/portal.js");
  assert.doesNotMatch(js, /reportarFallo/);
});

test("the navbar enables the account link, points it at the portal and gates it on a session", () => {
  /*
    Se fijan las propiedades de la entrada por separado, no su forma literal: el
    aserto anterior era un solo regex con las llaves y el orden exactos, y se
    rompió al agregarle `soloSesion` sin que nada estuviera mal.

    `soloSesion` importa desde acá: sin él, el menú ofrecía el portal a quien no
    tenía sesión, y el clic rebotaba al login (`requerirSesion()`).
  */
  const js = read("src/app/shared/navbar/navbar.js");
  const inicio = js.indexOf('texto: "Mi cuenta"');
  assert.notEqual(inicio, -1, "falta la entrada de cuenta");

  // Se corta en el cierre de la entrada: sin acotar, el regex encontraría
  // `soloSesion` en cualquier otra parte del archivo y el test no probaría nada.
  const cuerpo = js.slice(inicio, js.indexOf("},", inicio));

  assert.match(cuerpo, /href:\s*"\/app\/features\/portal\/"/, "debe apuntar al portal");
  assert.match(cuerpo, /habilitado:\s*true/, "debe estar habilitada");
  assert.match(cuerpo, /soloSesion:\s*true/,
    "debe pedir sesión: sin eso se le ofrece a quien no la tiene y el clic rebota al login");
});

test("perfil.service.js and portal.perfil.js load before portal.js, and after auth.service.js", () => {
  const html = read("src/app/features/portal/index.html");
  const auth = html.indexOf("/app/core/auth/auth.service.js");
  const servicio = html.indexOf("/app/core/perfil/perfil.service.js");
  const nucleo = html.indexOf("/app/features/portal/portal.perfil.js");
  const portal = html.indexOf("/app/features/portal/portal.js");

  [auth, servicio, nucleo, portal].forEach((indice) => assert.notEqual(indice, -1));
  assert.ok(auth < servicio, "perfil.service.js debe cargarse después de auth.service.js");
  assert.ok(servicio < portal, "perfil.service.js debe cargarse antes que portal.js");
  assert.ok(nucleo < portal, "portal.perfil.js debe cargarse antes que portal.js");
});

test("the portal stylesheet treats --border-subtle as the full shorthand it is", () => {
  const css = read("src/app/features/portal/portal.css");
  assert.doesNotMatch(css, /1px solid var\(--border-subtle\)/);
});

test("portal forms declare a flex layout with the gap .password-requirements depends on", () => {
  const css = read("src/app/features/portal/portal.css");
  const match = css.match(/\.portal__form\s*{([^}]*)}/);
  assert.ok(match, ".portal__form must be defined in portal.css");
  assert.match(match[1], /display:\s*flex/);
  assert.match(match[1], /gap:\s*1rem/);
});

test("the password and notification forms carry the portal__form layout class", () => {
  const html = read("src/app/features/portal/index.html");
  for (const id of ["formContrasena", "formCorreo"]) {
    const formTag = html.match(new RegExp(`<form id="${id}"[^>]*>`));
    assert.ok(formTag, `<form id="${id}"> not found`);
    assert.match(formTag[0], /class="portal__form"/, `#${id} is missing class="portal__form"`);
  }
});

test("portal__form's gap matches auth__form's gap (password-requirements' negative margin assumes it)", () => {
  const portalCss = read("src/app/features/portal/portal.css");
  const authCss = read("src/app/features/auth/auth.css");
  const portalGap = portalCss.match(/\.portal__form\s*{[^}]*gap:\s*([^;]+);/)[1].trim();
  const authGap = authCss.match(/\.auth__form\s*{[^}]*gap:\s*([^;]+);/)[1].trim();
  assert.equal(portalGap, authGap);
});

test("the password change form wires live requirement feedback", () => {
  const js = read("src/app/features/portal/portal.js");
  assert.match(js, /configurarRequisitosContrasena\(/);
});

test("the delete-account form ships hidden behind a reveal button", () => {
  const html = read("src/app/features/portal/index.html");
  const formTag = html.match(/<form id="formEliminarCuenta"[^>]*>/);
  assert.ok(formTag, "formEliminarCuenta not found");
  assert.match(formTag[0], /\bhidden\b/, "the form must start hidden");
  assert.match(html, /id="botonMostrarEliminarCuenta"/);
  assert.match(html, /id="eliminarCuentaContrasena"[^>]*type="password"|type="password"[^>]*id="eliminarCuentaContrasena"/);
});

test("a hidden portal form stays hidden: [hidden] must beat .portal__form's display:flex", () => {
  /*
    .portal__form es display:flex, que gana sobre la hoja del navegador para
    [hidden]. Sin esta regla el formulario de borrado se vería siempre, igual
    que pasaría con .portal__section.
  */
  const css = read("src/app/features/portal/portal.css");
  assert.match(css, /\.portal__form\[hidden\]\s*{[^}]*display:\s*none/);
});

test("the portal page loads the confirm-dialog assets it now depends on", () => {
  const html = read("src/app/features/portal/index.html");
  assert.match(html, /confirm-dialog\/confirm-dialog\.css/);
  assert.match(html, /confirm-dialog\/confirm-dialog\.js/);

  const dialogo = html.indexOf("confirm-dialog/confirm-dialog.js");
  const portal = html.indexOf("portal/portal.js");
  assert.ok(dialogo < portal, "confirm-dialog.js must load before portal.js");
});

test("account deletion re-authenticates before opening the typed confirmation", () => {
  const js = read("src/app/features/portal/portal.js");
  const cuerpo = js.match(/function configurarEliminarCuenta\(session\)\s*{[\s\S]*?\n  }/)[0];

  const reauth = cuerpo.indexOf("signInWithPassword");
  const dialogo = cuerpo.indexOf("confirmarConTexto");
  const borrado = cuerpo.indexOf("eliminarCuenta()");
  assert.ok(reauth >= 0 && dialogo >= 0 && borrado >= 0, "all three steps must exist");
  assert.ok(reauth < dialogo, "the password check must come before the dialog");
  assert.ok(dialogo < borrado, "the dialog must be confirmed before deleting");
});

test("the deletion dialog asks for the email, not a course name, and expects that exact email", () => {
  const js = read("src/app/features/portal/portal.js");
  const cuerpo = js.match(/function configurarEliminarCuenta\(session\)\s*{[\s\S]*?\n  }/)[0];
  assert.match(cuerpo, /etiquetaEntrada:\s*"Escribe tu correo para confirmar:"/);
  assert.match(cuerpo, /textoEsperado:\s*session\.user\.email/);
});

test("a deleted account is signed out locally and sent home", () => {
  const js = read("src/app/features/portal/portal.js");
  const cuerpo = js.match(/function configurarEliminarCuenta\(session\)\s*{[\s\S]*?\n  }/)[0];
  /*
    scope local, no global: la cuenta ya no existe, así que revocar sesiones
    contra el servidor fallaría; solo queda limpiar la sesión de este navegador.
  */
  assert.match(cuerpo, /cerrarSesion\(\{\s*scope:\s*"local"\s*\}\)/);
  // ventanaQueNavega(): en la capa «Configuración» el inicio se abre arriba,
  // no dentro del iframe (T7b).
  assert.match(cuerpo, /ventanaQueNavega\(\)\.location\.href\s*=\s*"\/"/);
});

test("eliminarCuenta never sends a user id: the edge function reads it from the JWT", () => {
  const js = read("src/app/core/auth/auth.service.js");
  const cuerpo = js.match(/async function eliminarCuenta\(\)\s*{([\s\S]*?)\n}/)[1];
  assert.match(cuerpo, /functions\.invoke\("delete-account",\s*\{\s*body:\s*\{\}\s*\}\)/);
  assert.doesNotMatch(cuerpo, /user\.id|userId|session/);
});

test("password errors (mismatch, weak, wrong current password) also raise a red toast", () => {
  const js = read("src/app/features/portal/portal.js");
  const match = js.match(/function mostrarErrorContrasena\([^)]*\)\s*{([^}]*)}/);
  assert.ok(match, "mostrarErrorContrasena not found");
  assert.match(match[1], /mostrarToast\(\s*mensaje\s*,\s*"error"\s*\)/);
});

test("invalid fields get a visible red border via the shared .field rule", () => {
  const css = read("src/app/shared/field/field.css");
  assert.match(css, /\.field\[aria-invalid="true"\]\s*{[^}]*border-color:\s*var\(--color-error\)/);
});

test("the portal layout collapses to one column only on mobile", () => {
  const css = read("src/app/features/portal/portal.css");
  assert.match(css, /\.portal__layout\s*{[^}]*grid-template-columns:\s*minmax\(220px,\s*260px\)/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*760px\)[\s\S]*?\.portal__layout\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
  );
  assert.doesNotMatch(
    css.split(/@media\s*\(max-width:\s*760px\)/)[0],
    /\.portal__layout\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
  );
});

test("the portal section markup matches the declared section catalog", () => {
  const html = read("src/app/features/portal/index.html");
  SECCIONES_PORTAL.forEach((seccion) => {
    assert.match(html, new RegExp(`id="seccion-${seccion.id}"`), `falta la sección ${seccion.id}`);
    assert.match(html, new RegExp(`href="#${seccion.id}"`), `falta el enlace a ${seccion.id}`);
  });
});

test("the portal is a «Configuración» panel with a ✕ that leaves it", () => {
  const html = read("src/app/features/portal/index.html");
  assert.match(html, /<h1[^>]*>Configuración<\/h1>/);
  assert.match(html, /<button[^>]*id="botonCerrarPortal"[^>]*aria-label="Cerrar configuración"/);
  const js = read("src/app/features/portal/portal.js");
  assert.match(js, /destinoAlCerrar\(document\.referrer,\s*window\.location\.origin\)/);
});

test("each subview declares its parent and a «← volver» link to «Acceso y seguridad»", () => {
  const html = read("src/app/features/portal/index.html");
  SECCIONES_PORTAL.filter((seccion) => seccion.padre).forEach((seccion) => {
    const etiqueta = html.match(new RegExp(`<section[^>]*id="seccion-${seccion.id}"[^>]*>`));
    assert.ok(etiqueta, `falta la sección ${seccion.id}`);
    assert.match(etiqueta[0], new RegExp(`data-padre="${seccion.padre}"`));
    const inicio = html.indexOf(etiqueta[0]);
    const markup = html.slice(inicio, html.indexOf("</section>", inicio));
    assert.match(markup, /<a[^>]*class="portal__volver"[^>]*href="#cuenta"|<a[^>]*href="#cuenta"[^>]*class="portal__volver"/);
  });
});

test("moving inside the panel replaces the history entry instead of adding one (L45)", () => {
  const js = read("src/app/features/portal/portal.js");
  assert.match(js, /hashDeEnlaceInterno\(/);
  assert.match(js, /window\.location\.replace\(hash\)/);
  assert.doesNotMatch(js, /pushState/);
  assert.match(js, /seccionDelMenu\(id/, "el menú marca al padre de una subvista");
});

test("the password form lives in its own subview, not in «Acceso y seguridad»", () => {
  const html = read("src/app/features/portal/index.html");
  const contrasena = markupSeccion(html, "contrasena");
  assert.match(contrasena, /<form id="formContrasena"/);
  const cuenta = markupSeccion(html, "cuenta");
  assert.doesNotMatch(cuenta, /id="formContrasena"/);
  // S16: una cuenta sólo de Google ve el aviso en el resumen, en lugar de la fila.
  assert.match(cuenta, /id="avisoSinContrasena"/);
  assert.doesNotMatch(contrasena, /id="avisoSinContrasena"/);
  assert.match(cuenta, /href="#contrasena"/);
  assert.match(cuenta, /href="#sesiones"/);
  assert.match(cuenta, /id="formEliminarCuenta"/, "Eliminar cuenta se queda en Acceso y seguridad: ahí vuelve Google");
});

/* Bloque C-bis — la decisión de producto: las secciones "Pronto" no simulan trabajar. */

function markupSeccion(html, id) {
  const inicio = html.indexOf(`id="seccion-${id}"`);
  assert.notEqual(inicio, -1, `no se encontró la sección ${id}`);
  const fin = html.indexOf("</section>", inicio);
  assert.notEqual(fin, -1, `la sección ${id} no cierra`);
  return html.slice(inicio, fin);
}

/* Bloque D — sección "Mi cuenta". */

test("the account section re-authenticates before changing the password", () => {
  /*
    No hay harness funcional para signInWithPassword contra un cliente real de
    Supabase en estos tests (sin red, sin mocks del SDK); en su lugar, un
    contrato por regex sobre el orden textual, al estilo de los tests de orden
    de <script> ya existentes, deja constancia de que la re-autenticación
    ocurre antes que el cambio de contraseña sin necesitar ese harness.
  */
  const js = read("src/app/features/portal/portal.js");
  const reauth = js.indexOf("signInWithPassword");
  const cambio = js.indexOf("cambiarContrasena(nueva)");
  assert.notEqual(reauth, -1, "falta la re-autenticación");
  assert.notEqual(cambio, -1, "falta la llamada a cambiarContrasena");
  assert.ok(reauth < cambio, "signInWithPassword debe ejecutarse antes que cambiarContrasena");
});

test("the account email field is read-only and there is no role input", () => {
  const html = read("src/app/features/portal/index.html");
  const markup = markupSeccion(html, "cuenta");
  assert.match(markup, /id="cuentaEmail"[^>]*\breadonly\b/, "el correo debe ser readonly");
  assert.doesNotMatch(markup, /name="rol"/, "no debe existir un campo editable de rol");
});

test("unavailable portal sections ship no interactive controls at all", () => {
  /*
    Un input o un botón en una sección que todavía no hace nada promete una
    capacidad inexistente. Estas dos secciones solo explican qué falta.
    "correo" salió de esta lista: ya tiene backend real (ver bloque E).
  */
  const html = read("src/app/features/portal/index.html");
  ["plan", "pagos"].forEach((id) => {
    const markup = markupSeccion(html, id);
    assert.doesNotMatch(markup, /<input/i, `${id} no debe tener inputs`);
    assert.doesNotMatch(markup, /<select/i, `${id} no debe tener selects`);
    assert.doesNotMatch(markup, /<textarea/i, `${id} no debe tener textareas`);
    assert.doesNotMatch(markup, /<button/i, `${id} no debe tener botones`);
    assert.doesNotMatch(markup, /<a\b/i, `${id} no debe tener enlaces`);
  });
});

test("Mi plan y Pagos llevan «Pronto» junto al título y conservan su explicación en una tarjeta del panel (T10, L63)", () => {
  const html = read("src/app/features/portal/index.html");
  const casos = [
    { id: "plan", titulo: "tituloPlan", texto: "Todavía no hay planes de suscripción" },
    { id: "pagos", titulo: "tituloPagos", texto: "Todavía no cobramos desde el sitio" },
  ];
  casos.forEach(({ id, titulo, texto }) => {
    const markup = markupSeccion(html, id);
    const h2 = markup.match(new RegExp(`<h2[^>]*id="${titulo}"[^>]*>([\\s\\S]*?)</h2>`));
    assert.ok(h2, `falta el título de ${id}`);
    assert.match(h2[1], /<span class="portal__insignia-titulo">Pronto<\/span>/, `${id}: la insignia va junto al título`);
    assert.match(markup, /<div class="portal__filas">\s*<p class="portal__fila portal__fila--fija portal__fila-desc">/, `${id}: tarjeta con el estilo del panel`);
    assert.ok(markup.includes(texto), `${id} conserva su texto de hoy`);
    assert.doesNotMatch(markup, /coming-soon/, `${id} ya no usa la tarjeta de «coming-soon»`);
  });
  assert.doesNotMatch(html, /coming-soon\.css/, "el portal ya no carga la hoja de «coming-soon»");
});

test("«Cerrar sesión» es una fila que explica que solo sale de este dispositivo (T10, L63)", () => {
  const html = read("src/app/features/portal/index.html");
  const cuenta = markupSeccion(html, "cuenta");
  const fila = cuenta.match(/<div class="portal__fila portal__fila--fija portal__fila--accion" id="filaCerrarSesion">([\s\S]*?)<\/div>/);
  assert.ok(fila, "falta la fila #filaCerrarSesion");
  assert.match(fila[1], /<span class="portal__fila-titulo">Cerrar sesión<\/span>/);
  assert.match(fila[1], /<span class="portal__fila-desc">Sales de tu cuenta solo en este dispositivo\.<\/span>/);
  assert.match(fila[1], /<button type="button" class="portal__boton-fila" id="botonCerrarSesion">Cerrar sesión<\/button>/);
  assert.doesNotMatch(cuenta, /portal__account-actions/, "el botón suelto desaparece");
  assert.ok(cuenta.indexOf('id="filaCerrarSesion"') < cuenta.indexOf("portal__danger-zone"), "la fila va antes de Eliminar cuenta");
});

test("en el teléfono, el botón de «Cerrar sesión» baja y ocupa todo el ancho (T10, L63)", () => {
  const css = read("src/app/features/portal/portal.css");
  const movil = css.slice(css.indexOf("@media (max-width: 760px)"));
  assert.match(movil, /\.portal__fila--accion\s*\{[^}]*flex-wrap:\s*wrap;/);
  assert.match(movil, /\.portal__fila--accion \.portal__boton-fila\s*\{[^}]*flex-basis:\s*100%;/);
});

test("Eliminar cuenta con Google usa el texto de S16 y sigue oculto tras «Eliminar cuenta» (T10, L63)", () => {
  const html = read("src/app/features/portal/index.html");
  const aviso = html.match(/<div class="portal__form" id="avisoSinContrasenaEliminar" hidden>([\s\S]*?)<\/div>\s*<form/);
  assert.ok(aviso, "el aviso de Google nace oculto, antes del formulario con contraseña");
  assert.match(aviso[1], /<p class="portal__section-intro">Para confirmar que eres tú, te pediremos iniciar sesión otra vez con Google\.<\/p>/);
  assert.doesNotMatch(aviso[1], /Vuelve a entrar con Google/, "el texto anterior se va");
  assert.match(aviso[1], /id="botonReautenticarGoogle"[^>]*>Continuar con Google<\/button>/);
  // El flujo con contraseña sigue igual: botón rojo, formulario oculto y su campo.
  assert.match(html, /<button type="button" class="button button--outline portal__danger-button" id="botonMostrarEliminarCuenta">Eliminar cuenta<\/button>/);
  assert.match(html, /<form id="formEliminarCuenta" class="portal__form" novalidate hidden>/);
  assert.match(html, /id="eliminarCuentaContrasena"[^>]*autocomplete="current-password"/);
});

/* Bloque E — sección "Preferencias de correo". */

test("the email preference section is now declared available", () => {
  const correo = SECCIONES_PORTAL.find((seccion) => seccion.id === "correo");
  assert.equal(correo.disponible, true);
});

test("the notification section ships one switch and an alert region, with no save button (S17)", () => {
  const html = read("src/app/features/portal/index.html");
  const markup = markupSeccion(html, "correo");

  assert.doesNotMatch(markup, /<input/i, "el interruptor reemplaza a la palomita");
  const interruptor = markup.match(/<button[^>]*id="correoCursoNuevo"[^>]*>/);
  assert.ok(interruptor, "falta el interruptor #correoCursoNuevo");
  assert.match(interruptor[0], /type="button"/);
  assert.match(interruptor[0], /role="switch"/);
  assert.match(interruptor[0], /aria-checked="false"/);
  assert.match(markup, /<label[^>]*for="correoCursoNuevo"[^>]*>Avísame en la app cuando se publique un curso nuevo\.<\/label>/);
  assert.match(markup, /id="correoStatus"[^>]*role="alert"/);
  assert.doesNotMatch(markup, /type="submit"/, "se guarda al tocarlo, sin «Guardar»");
  assert.doesNotMatch(markup, /coming-soon__description/, "ya no es un placeholder");
});

test("the correo nav link no longer carries the coming-soon badge", () => {
  const html = read("src/app/features/portal/index.html");
  const inicio = html.indexOf('href="#correo"');
  assert.notEqual(inicio, -1);
  const fin = html.indexOf("</a>", inicio);
  const enlace = html.slice(inicio, fin);
  assert.doesNotMatch(enlace, /portal__nav-badge/);
});

test("portal.correo.js loads after portal.perfil.js and before portal.js", () => {
  const html = read("src/app/features/portal/index.html");
  const perfilNucleo = html.indexOf("/app/features/portal/portal.perfil.js");
  const correoNucleo = html.indexOf("/app/features/portal/portal.correo.js");
  const portal = html.indexOf("/app/features/portal/portal.js");

  [perfilNucleo, correoNucleo, portal].forEach((indice) => assert.notEqual(indice, -1));
  assert.ok(perfilNucleo < correoNucleo, "portal.correo.js debe cargarse después de portal.perfil.js");
  assert.ok(correoNucleo < portal, "portal.correo.js debe cargarse antes que portal.js");
});

test("auth.service.js and perfil.service.js select avisos_curso_nuevo, or the checkbox would always render unchecked", () => {
  const authJs = read("src/app/core/auth/auth.service.js");
  const perfilServicio = read("src/app/core/perfil/perfil.service.js");
  // En auth.service.js la columna vive en COLUMNAS_PERFIL_BASE, que es lo que
  // arma el select: pedirla ahí es pedirla en las dos lecturas, la ancha y el
  // reintento angosto.
  assert.match(authJs, /const COLUMNAS_PERFIL_BASE = "[^"]*avisos_curso_nuevo[^"]*"/);
  assert.match(perfilServicio, /\.select\(\s*"[^"]*avisos_curso_nuevo[^"]*"\s*\)/);
});

test("the email preference section no longer promises delivery by correo: it's push-only now", () => {
  /*
    0026_anuncio_solo_push.sql cambió el envío de publicación de curso a
    solo push; el panel de admin ya se actualizó. Esta era la última copia
    del portal de cuenta que seguía prometiendo correo. La sección conserva
    su id "correo" y otros identificadores con esa raíz (routing/URL
    fragment, wiring de JS: fuera de alcance), así que esta comprobación se
    limita al texto visible en vez de al markup completo, que sí contendría
    "correo" dentro de ids como formCorreo o correoStatus.
  */
  const html = read("src/app/features/portal/index.html");
  const markup = markupSeccion(html, "correo");

  const titulo = markup.match(/<h2[^>]*>([^<]*)<\/h2>/)[1];
  const intro = markup.match(/portal__section-intro">([^<]*)<\/p>/)[1];
  const etiquetaCheckbox = markup.match(/<label[^>]*>([^<]*)<\/label>/)[1];
  const nota = markup.match(/portal__field-note">([^<]*)<\/p>/)[1];

  [titulo, intro, etiquetaCheckbox, nota].forEach((texto) => {
    assert.doesNotMatch(texto, /correo/i, `el texto visible no debe mencionar "correo": "${texto}"`);
  });
});

test("portal.js converts the DB's snake_case avisos_curso_nuevo into the checkbox's camelCase field", () => {
  /*
    Bug real encontrado probando en el navegador: la BD devuelve
    avisos_curso_nuevo, pero normalizarPreferenciasCorreo espera
    avisosCursoNuevo. Sin esta conversión el checkbox nace siempre
    desmarcado sin importar el valor real guardado.
  */
  const js = read("src/app/features/portal/portal.js");
  assert.match(js, /avisosCursoNuevo:\s*perfil\s*&&\s*perfil\.avisos_curso_nuevo/);
});

/*
  T7c (S14): detalles de la maqueta «Configuración». Cada enlace del menú
  lleva su icono decorativo delante del nombre, sin cambiar el destino.
*/
function enlacesDelMenu(html) {
  const inicio = html.indexOf('id="portalNav"');
  const fin = html.indexOf("</nav>", inicio);
  return html.slice(inicio, fin).match(/<a class="portal__nav-link"[\s\S]*?<\/a>/g) || [];
}

test("every portal nav link starts with a decorative icon and keeps its visible name", () => {
  const enlaces = enlacesDelMenu(read("src/app/features/portal/index.html"));
  const nombres = ["Editar perfil", "Acceso y seguridad", "Preferencias de avisos", "Mi plan", "Pagos"];

  assert.equal(enlaces.length, nombres.length);
  enlaces.forEach((enlace, i) => {
    assert.match(enlace, /^<a[^>]*>\s*<svg[^>]*aria-hidden="true"/, `el enlace ${nombres[i]} debe empezar con su icono`);
    const nombre = enlace.match(/<span class="portal__nav-texto">([^<]*)<\/span>/);
    assert.ok(nombre, `el enlace ${nombres[i]} debe envolver su nombre`);
    assert.equal(nombre[1], nombres[i]);
  });
});

test("the portal nav links keep their hashes, sections, and coming-soon badges", () => {
  const enlaces = enlacesDelMenu(read("src/app/features/portal/index.html"));
  const destinos = enlaces.map((enlace) => {
    const [, href, seccion] = enlace.match(/href="([^"]*)" data-seccion="([^"]*)"/);
    return { href, seccion, pronto: /portal__nav-badge">Pronto</.test(enlace) };
  });

  assert.deepEqual(destinos, [
    { href: "#perfil", seccion: "perfil", pronto: false },
    { href: "#cuenta", seccion: "cuenta", pronto: false },
    { href: "#correo", seccion: "correo", pronto: false },
    { href: "#plan", seccion: "plan", pronto: true },
    { href: "#pagos", seccion: "pagos", pronto: true },
  ]);
});

test("the portal startup message names «Configuración»", () => {
  const html = read("src/app/features/portal/index.html");
  const inicio = html.indexOf('id="portalStartup"');
  const arranque = html.slice(inicio, html.indexOf("</div>", inicio));

  assert.match(arranque, /<p>Cargando Configuración…<\/p>/);
  assert.doesNotMatch(html, /Cargando tu portal/);
});

test("section titles and their introductions use the mockup typography", () => {
  const css = read("src/app/features/portal/portal.css");
  const regla = (selector) => {
    const inicio = css.indexOf(`\n${selector} {`);
    assert.notEqual(inicio, -1, `falta la regla ${selector}`);
    return css.slice(inicio, css.indexOf("}", inicio));
  };

  const titulo = regla(".portal__section-title");
  assert.match(titulo, /font-size:\s*26px/);
  assert.match(titulo, /font-weight:\s*500/);

  // Sólo la introducción que sigue al título: las de «Eliminar cuenta» se rediseñan en T10.
  const intro = regla(".portal__section-title + .portal__section-intro");
  assert.match(intro, /font-size:\s*15px/);
  assert.match(intro, /color:\s*var\(--cfg-texto-2\)/);
});

/*
  T8 (S15, S17, L56): «Editar perfil» en dos tarjetas que guardan cada una lo
  suyo, y el aviso de curso nuevo con interruptor.
*/
test("«Editar perfil» keeps its introduction and splits into the «Tu nombre» and «Tu teléfono» cards", () => {
  const markup = markupSeccion(read("src/app/features/portal/index.html"), "perfil");
  assert.match(markup, /portal__section-intro">Actualiza tu nombre, apellidos y teléfono\.<\/p>/);

  const nombre = markup.match(/<form id="formNombre"[\s\S]*?<\/form>/);
  assert.ok(nombre, "falta la tarjeta #formNombre");
  assert.match(nombre[0], />Tu nombre</);
  assert.match(nombre[0], />Escribe tu nombre y apellidos como quieres que aparezcan\.</);
  assert.match(nombre[0], /id="perfilNombre"/);
  assert.match(nombre[0], /id="perfilApellidos"/);
  assert.match(nombre[0], /<label for="perfilApellidos">Apellidos<\/label>/);
  assert.match(nombre[0], /id="nombreStatus"[^>]*role="alert"/);
  assert.match(nombre[0], /<button type="submit"[^>]*>Guardar<\/button>/);
  assert.doesNotMatch(nombre[0], /perfilTelefono/);

  const telefono = markup.match(/<form id="formTelefono"[\s\S]*?<\/form>/);
  assert.ok(telefono, "falta la tarjeta #formTelefono");
  assert.match(telefono[0], />Tu teléfono <span class="portal__opcional">\(opcional\)<\/span></);
  assert.match(telefono[0], />Incluye el código de país, por ejemplo \+52 55 1234 5678\.</);
  assert.match(telefono[0], /id="telefonoStatus"[^>]*role="alert"/);
  assert.match(telefono[0], /<button type="submit"[^>]*>Guardar<\/button>/);

  // Sin los textos de la maqueta que no aplican a Taudux (L56).
  assert.doesNotMatch(markup, /SMS|Máximo 50 caracteres|personas con las que trabajas|avisos de seguridad/);
});

test("the phone card has a country button with a searchable list and the national number apart", () => {
  const markup = markupSeccion(read("src/app/features/portal/index.html"), "perfil");
  const boton = markup.match(/<button[^>]*id="botonPais"[^>]*>/);
  assert.ok(boton, "falta el botón de país");
  assert.match(boton[0], /type="button"/);
  assert.match(boton[0], /aria-haspopup="listbox"/);
  assert.match(boton[0], /aria-expanded="false"/);
  assert.match(boton[0], /aria-controls="listaPaises"/);
  assert.match(markup, /<input[^>]*id="buscarPais"[^>]*type="search"/);
  assert.match(markup, /<ul[^>]*id="listaPaises"[^>]*role="listbox"/);
  const numero = markup.match(/<input[^>]*id="perfilTelefono"[^>]*>/);
  assert.match(numero[0], /type="tel"/);
  assert.match(numero[0], /autocomplete="tel-national"/);
  assert.match(markup, /<label for="perfilTelefono"[^>]*>Número de teléfono<\/label>/);
});

test("flags are served from the site, never from flagcdn.com (L56)", () => {
  const html = read("src/app/features/portal/index.html");
  const js = read("src/app/features/portal/portal.js");
  assert.doesNotMatch(html + js, /flagcdn/);
  assert.match(js, /\/assets\/vendor\/flag-icons-7\.2\.3\//);
});

test("portal.telefono.js loads before portal.js", () => {
  const html = read("src/app/features/portal/index.html");
  const telefono = html.indexOf("/app/features/portal/portal.telefono.js");
  assert.notEqual(telefono, -1);
  assert.ok(telefono < html.indexOf("/app/features/portal/portal.js"));
});

test("a card only saves its own fields: an old invalid phone never blocks saving the name", () => {
  const guardado = { nombre: "Ana", apellidos: "Ruiz", telefono: "55 1234" };
  const cambios = cambiosDeTarjeta(guardado, { nombre: "Ana María", apellidos: "Ruiz" });
  assert.deepEqual(cambios, { nombre: "Ana María" });
  assert.deepEqual(validarCambios(cambios), { ok: true });
});

test("a card with nothing changed has nothing to save", () => {
  const guardado = { nombre: "Ana", apellidos: "Ruiz", telefono: null };
  assert.deepEqual(cambiosDeTarjeta(guardado, { telefono: "" }), {});
  assert.deepEqual(cambiosDeTarjeta(guardado, { nombre: " Ana ", apellidos: "Ruiz" }), {});
});

test("the phone card saves only the phone", () => {
  const guardado = { nombre: "Ana", apellidos: "", telefono: "" };
  assert.deepEqual(cambiosDeTarjeta(guardado, { telefono: "+525512345678" }), { telefono: "+525512345678" });
});

test("touching the switch saves the opposite value and shows what the database kept", async () => {
  const llamadas = [];
  const resultado = await alternarPreferenciaCorreo({ avisosCursoNuevo: false }, async (cambios) => {
    llamadas.push(cambios);
    return { ok: true, data: { avisos_curso_nuevo: true } };
  });
  assert.deepEqual(llamadas, [{ avisos_curso_nuevo: true }]);
  assert.deepEqual(resultado, { ok: true, preferencias: { avisosCursoNuevo: true } });
});

test("when saving the switch fails it goes back to how it was and carries the error (S17)", async () => {
  const resultado = await alternarPreferenciaCorreo({ avisosCursoNuevo: true }, async () => ({
    ok: false,
    mensaje: "No se pudieron guardar los cambios.",
  }));
  assert.deepEqual(resultado, {
    ok: false,
    preferencias: { avisosCursoNuevo: true },
    mensaje: "No se pudieron guardar los cambios.",
  });
});

test("the switch is on in the «Guardar» blue with a white knob", () => {
  const css = read("src/app/features/portal/portal.css");
  const encendido = css.match(/\.portal__switch\[aria-checked="true"\]\s*{([^}]*)}/);
  assert.ok(encendido, "falta el estado encendido del interruptor");
  assert.match(encendido[1], /background-color:\s*var\(--cfg-primario\)/);
  assert.match(css, /--cfg-primario:\s*#1149a5/);
  const perilla = css.match(/\.portal__switch-perilla\s*{([^}]*)}/);
  assert.match(perilla[1], /background-color:\s*#fff/);
  const guardar = css.match(/\.portal__boton-guardar\s*{([^}]*)}/);
  assert.match(guardar[1], /background-color:\s*var\(--cfg-primario\)/);
});

test("portal.js keeps the «Preferencia guardada.» toast and saves the switch on click", () => {
  const js = read("src/app/features/portal/portal.js");
  assert.match(js, /mostrarToast\("Preferencia guardada\.", "success"\)/);
  assert.match(js, /alternarPreferenciaCorreo\(/);
  assert.match(js, /setAttribute\("aria-checked"/);
});

test("when saving the switch throws (no connection) it also goes back to how it was", async () => {
  const resultado = await alternarPreferenciaCorreo({ avisosCursoNuevo: false }, async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.deepEqual(resultado, {
    ok: false,
    preferencias: { avisosCursoNuevo: false },
    mensaje: "No se pudieron guardar los cambios.",
  });
});

test("the phone number field takes its width from the card, not its own, so 390 px does not scroll sideways", () => {
  // Medido en Chrome a 390 px: con el ancho propio del input, la columna de la
  // sección crecía a 381 px dentro de 358 y la página scrolleaba 7 px.
  const css = read("src/app/features/portal/portal.css");
  const numero = css.match(/\.portal__telefono-numero\s*{([^}]*)}/);
  assert.match(numero[1], /flex:\s*1/);
  assert.match(numero[1], /(?<!-)inline-size:\s*0/);
});

test("the «Configuración» header stays on top while the panel scrolls, in the page and in the overlay", () => {
  /*
    Dentro de la capa se desliza todo el documento del iframe: sin sticky, la
    cabecera con la ✕ se iba hacia arriba con el contenido. En la página queda
    bajo la barra del sitio; en la capa, pegada arriba. El menú lateral, que
    también es sticky, se fija a la misma distancia a la que nace (el margen de
    1.5rem de los hijos del panel): así no se desliza ni un poco antes de
    pararse (L75).
  */
  const css = read("src/app/features/portal/portal.css");
  const regla = (selector) => {
    const escapado = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const encontrada = css.match(new RegExp(`(?:^|\\n)${escapado}\\s*\\{([^}]*)\\}`));
    assert.ok(encontrada, `${selector} must be defined in portal.css`);
    return encontrada[1];
  };
  const cabecera = regla(".portal__header");
  assert.match(cabecera, /position:\s*sticky;/);
  assert.match(cabecera, /top:\s*var\(--navbar-height\);/);
  assert.match(cabecera, /background-color:\s*var\(--cfg-fondo\);/, "opaca: el contenido pasa por debajo");
  assert.match(regla(".portal--embebido .portal__header"), /top:\s*0;/);
  assert.match(regla(".portal__sidebar"), /top:\s*calc\(var\(--navbar-height\) \+ var\(--portal-cabecera\) \+ 1\.5rem\);/);
  assert.match(regla(".portal--embebido .portal__sidebar"), /top:\s*calc\(var\(--portal-cabecera\) \+ 1\.5rem\);/);
});
