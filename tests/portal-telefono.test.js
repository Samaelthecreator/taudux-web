const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

const {
  PAISES_TELEFONO,
  PAISES_DESTACADOS,
  separarTelefono,
  unirTelefono,
  filtrarPaises,
} = require(path.join(ROOT, "src/app/features/portal/portal.telefono.js"));

const { PATRON_TELEFONO_PERFIL } = require(path.join(ROOT, "src/app/features/portal/portal.perfil.js"));

/* T8 (S15, L56): selector de país del teléfono. */

test("the country list is sorted by its Spanish name and every country has an ISO code and a dial code", () => {
  const nombres = PAISES_TELEFONO.map((pais) => pais.nombre);
  assert.deepEqual(nombres, [...nombres].sort((a, b) => a.localeCompare(b, "es")));
  PAISES_TELEFONO.forEach((pais) => {
    assert.match(pais.iso, /^[a-z]{2}$/);
    assert.match(pais.lada, /^[1-9]\d{0,3}$/);
  });
  assert.equal(new Set(PAISES_TELEFONO.map((pais) => pais.iso)).size, PAISES_TELEFONO.length);
  assert.deepEqual(PAISES_DESTACADOS, ["mx", "us"]);
});

test("every country in the list has its own flag served from the site", () => {
  const carpeta = path.join(ROOT, "src/assets/vendor/flag-icons-7.2.3");
  PAISES_TELEFONO.forEach((pais) => {
    assert.ok(fs.existsSync(path.join(carpeta, `${pais.iso}.svg`)), `falta la bandera ${pais.iso}`);
  });
  assert.ok(fs.existsSync(path.join(carpeta, "LICENSE")), "la licencia MIT de flag-icons viaja con las banderas");
});

test("a Mexican number splits into México and its national digits", () => {
  assert.deepEqual(separarTelefono("+525512345678"), { iso: "mx", nacional: "5512345678" });
});

test("a shared dial code opens on its most common country (L56)", () => {
  assert.equal(separarTelefono("+12015550123").iso, "us");
  assert.equal(separarTelefono("+74951234567").iso, "ru");
  assert.equal(separarTelefono("+390612345678").iso, "it");
});

test("the longest dial code wins: +1264 is Anguila, not the United States", () => {
  assert.deepEqual(separarTelefono("+12645551234"), { iso: "ai", nacional: "5551234" });
});

test("no phone saved opens on México with an empty number", () => {
  assert.deepEqual(separarTelefono(""), { iso: "mx", nacional: "" });
  assert.deepEqual(separarTelefono(null), { iso: "mx", nacional: "" });
  assert.deepEqual(separarTelefono(undefined), { iso: "mx", nacional: "" });
});

test("a saved phone that is not in international format opens on México with the text as it was", () => {
  assert.deepEqual(separarTelefono(" 55 1234 5678 "), { iso: "mx", nacional: "55 1234 5678" });
  assert.deepEqual(separarTelefono("+999123"), { iso: "mx", nacional: "+999123" });
});

test("joining the country and the number gives the same format saved today", () => {
  assert.equal(unirTelefono("mx", "55 1234 5678"), "+525512345678");
  assert.equal(unirTelefono("us", "(201) 555-0123"), "+12015550123");
  assert.match(unirTelefono("mx", "55 1234 5678"), PATRON_TELEFONO_PERFIL);
});

test("an empty number means no phone, whatever the country", () => {
  assert.equal(unirTelefono("mx", ""), "");
  assert.equal(unirTelefono("us", "   "), "");
});

test("a number typed with its own + code is kept as typed, without the chosen country", () => {
  assert.equal(unirTelefono("mx", "+1 201 555 0123"), "+12015550123");
});

test("text that is not a phone number is not turned into one, so validation rejects it", () => {
  const unido = unirTelefono("mx", "abc");
  assert.doesNotMatch(unido, PATRON_TELEFONO_PERFIL);
  assert.notEqual(unido, "");
});

test("an unknown country code falls back to México when joining", () => {
  assert.equal(unirTelefono("zz", "5512345678"), "+525512345678");
});

test("splitting and joining a saved phone gives it back unchanged", () => {
  ["+525512345678", "+12015550123", "+12645551234", "+74951234567", "+390612345678", "+34612345678"].forEach(
    (telefono) => {
      const { iso, nacional } = separarTelefono(telefono);
      assert.equal(unirTelefono(iso, nacional), telefono);
    },
  );
});

test("the country search ignores accents and case, and also matches by dial code", () => {
  assert.deepEqual(
    filtrarPaises("mexico").map((pais) => pais.iso),
    ["mx"],
  );
  assert.ok(filtrarPaises("JAPÓN").some((pais) => pais.iso === "jp"));
  assert.ok(filtrarPaises("+52").some((pais) => pais.iso === "mx"));
  assert.ok(filtrarPaises("52").some((pais) => pais.iso === "mx"));
});

test("an empty search returns every country and a search with no match returns none", () => {
  assert.equal(filtrarPaises("").length, PAISES_TELEFONO.length);
  assert.equal(filtrarPaises("   ").length, PAISES_TELEFONO.length);
  assert.deepEqual(filtrarPaises("zzzz"), []);
});
