/*
  Núcleo puro del teléfono de "Editar perfil" (T8, S15): la lista de países
  del selector, partir un teléfono guardado en país + número y volver a
  unirlos. Sin DOM, igual que portal.perfil.js: Node lo requiere directo en
  los tests.

  En la base el teléfono sigue guardado entero, como siempre (+525512345678):
  el país no se guarda. Por eso las ladas que comparten varios países abren en
  el más común (L56).
*/

// ISO | nombre | lada. Copiada de la maqueta de «Configuración» (L51); cada
// ISO tiene su bandera en /assets/vendor/flag-icons-7.2.3/.
const DATOS_PAISES_TELEFONO =
  "af|Afganistán|93;" +
  "al|Albania|355;" +
  "de|Alemania|49;" +
  "ad|Andorra|376;" +
  "ao|Angola|244;" +
  "ai|Anguila|1264;" +
  "ag|Antigua y Barbuda|1268;" +
  "sa|Arabia Saudita|966;" +
  "dz|Argelia|213;" +
  "ar|Argentina|54;" +
  "am|Armenia|374;" +
  "aw|Aruba|297;" +
  "au|Australia|61;" +
  "at|Austria|43;" +
  "az|Azerbaiyán|994;" +
  "bs|Bahamas|1242;" +
  "bd|Bangladés|880;" +
  "bb|Barbados|1246;" +
  "bh|Baréin|973;" +
  "be|Bélgica|32;" +
  "bz|Belice|501;" +
  "bj|Benín|229;" +
  "bm|Bermudas|1441;" +
  "by|Bielorrusia|375;" +
  "bo|Bolivia|591;" +
  "ba|Bosnia y Herzegovina|387;" +
  "bw|Botsuana|267;" +
  "br|Brasil|55;" +
  "bn|Brunéi|673;" +
  "bg|Bulgaria|359;" +
  "bf|Burkina Faso|226;" +
  "bi|Burundi|257;" +
  "bt|Bután|975;" +
  "cv|Cabo Verde|238;" +
  "kh|Camboya|855;" +
  "cm|Camerún|237;" +
  "ca|Canadá|1;" +
  "qa|Catar|974;" +
  "td|Chad|235;" +
  "cl|Chile|56;" +
  "cn|China|86;" +
  "cy|Chipre|357;" +
  "va|Ciudad del Vaticano|39;" +
  "co|Colombia|57;" +
  "km|Comoras|269;" +
  "cg|Congo|242;" +
  "cd|Congo (Rep. Dem.)|243;" +
  "kp|Corea del Norte|850;" +
  "kr|Corea del Sur|82;" +
  "ci|Costa de Marfil|225;" +
  "cr|Costa Rica|506;" +
  "hr|Croacia|385;" +
  "cu|Cuba|53;" +
  "cw|Curazao|599;" +
  "dk|Dinamarca|45;" +
  "dm|Dominica|1767;" +
  "ec|Ecuador|593;" +
  "eg|Egipto|20;" +
  "sv|El Salvador|503;" +
  "ae|Emiratos Árabes Unidos|971;" +
  "er|Eritrea|291;" +
  "sk|Eslovaquia|421;" +
  "si|Eslovenia|386;" +
  "es|España|34;" +
  "us|Estados Unidos|1;" +
  "ee|Estonia|372;" +
  "sz|Esuatini|268;" +
  "et|Etiopía|251;" +
  "ph|Filipinas|63;" +
  "fi|Finlandia|358;" +
  "fj|Fiyi|679;" +
  "fr|Francia|33;" +
  "ga|Gabón|241;" +
  "gm|Gambia|220;" +
  "ge|Georgia|995;" +
  "gh|Ghana|233;" +
  "gi|Gibraltar|350;" +
  "gd|Granada|1473;" +
  "gr|Grecia|30;" +
  "gl|Groenlandia|299;" +
  "gp|Guadalupe|590;" +
  "gu|Guam|1671;" +
  "gt|Guatemala|502;" +
  "gf|Guayana Francesa|594;" +
  "gn|Guinea|224;" +
  "gq|Guinea Ecuatorial|240;" +
  "gw|Guinea-Bisáu|245;" +
  "gy|Guyana|592;" +
  "ht|Haití|509;" +
  "hn|Honduras|504;" +
  "hk|Hong Kong|852;" +
  "hu|Hungría|36;" +
  "in|India|91;" +
  "id|Indonesia|62;" +
  "iq|Irak|964;" +
  "ir|Irán|98;" +
  "ie|Irlanda|353;" +
  "is|Islandia|354;" +
  "ky|Islas Caimán|1345;" +
  "fo|Islas Feroe|298;" +
  "mh|Islas Marshall|692;" +
  "sb|Islas Salomón|677;" +
  "tc|Islas Turcas y Caicos|1649;" +
  "vg|Islas Vírgenes Británicas|1284;" +
  "vi|Islas Vírgenes de EE. UU.|1340;" +
  "il|Israel|972;" +
  "it|Italia|39;" +
  "jm|Jamaica|1876;" +
  "jp|Japón|81;" +
  "jo|Jordania|962;" +
  "kz|Kazajistán|7;" +
  "ke|Kenia|254;" +
  "kg|Kirguistán|996;" +
  "ki|Kiribati|686;" +
  "xk|Kosovo|383;" +
  "kw|Kuwait|965;" +
  "la|Laos|856;" +
  "ls|Lesoto|266;" +
  "lv|Letonia|371;" +
  "lb|Líbano|961;" +
  "lr|Liberia|231;" +
  "ly|Libia|218;" +
  "li|Liechtenstein|423;" +
  "lt|Lituania|370;" +
  "lu|Luxemburgo|352;" +
  "mo|Macao|853;" +
  "mk|Macedonia del Norte|389;" +
  "mg|Madagascar|261;" +
  "my|Malasia|60;" +
  "mw|Malaui|265;" +
  "mv|Maldivas|960;" +
  "ml|Malí|223;" +
  "mt|Malta|356;" +
  "ma|Marruecos|212;" +
  "mq|Martinica|596;" +
  "mu|Mauricio|230;" +
  "mr|Mauritania|222;" +
  "mx|México|52;" +
  "fm|Micronesia|691;" +
  "md|Moldavia|373;" +
  "mc|Mónaco|377;" +
  "mn|Mongolia|976;" +
  "me|Montenegro|382;" +
  "ms|Montserrat|1664;" +
  "mz|Mozambique|258;" +
  "mm|Myanmar|95;" +
  "na|Namibia|264;" +
  "nr|Nauru|674;" +
  "np|Nepal|977;" +
  "ni|Nicaragua|505;" +
  "ne|Níger|227;" +
  "ng|Nigeria|234;" +
  "no|Noruega|47;" +
  "nc|Nueva Caledonia|687;" +
  "nz|Nueva Zelanda|64;" +
  "om|Omán|968;" +
  "nl|Países Bajos|31;" +
  "pk|Pakistán|92;" +
  "pw|Palaos|680;" +
  "ps|Palestina|970;" +
  "pa|Panamá|507;" +
  "pg|Papúa Nueva Guinea|675;" +
  "py|Paraguay|595;" +
  "pe|Perú|51;" +
  "pf|Polinesia Francesa|689;" +
  "pl|Polonia|48;" +
  "pt|Portugal|351;" +
  "pr|Puerto Rico|1;" +
  "gb|Reino Unido|44;" +
  "cf|República Centroafricana|236;" +
  "cz|República Checa|420;" +
  "do|República Dominicana|1;" +
  "re|Reunión|262;" +
  "rw|Ruanda|250;" +
  "ro|Rumania|40;" +
  "ru|Rusia|7;" +
  "ws|Samoa|685;" +
  "kn|San Cristóbal y Nieves|1869;" +
  "sm|San Marino|378;" +
  "vc|San Vicente y las Granadinas|1784;" +
  "lc|Santa Lucía|1758;" +
  "st|Santo Tomé y Príncipe|239;" +
  "sn|Senegal|221;" +
  "rs|Serbia|381;" +
  "sc|Seychelles|248;" +
  "sl|Sierra Leona|232;" +
  "sg|Singapur|65;" +
  "sx|Sint Maarten|1721;" +
  "sy|Siria|963;" +
  "so|Somalia|252;" +
  "lk|Sri Lanka|94;" +
  "za|Sudáfrica|27;" +
  "sd|Sudán|249;" +
  "ss|Sudán del Sur|211;" +
  "se|Suecia|46;" +
  "ch|Suiza|41;" +
  "sr|Surinam|597;" +
  "th|Tailandia|66;" +
  "tw|Taiwán|886;" +
  "tz|Tanzania|255;" +
  "tj|Tayikistán|992;" +
  "tl|Timor Oriental|670;" +
  "tg|Togo|228;" +
  "to|Tonga|676;" +
  "tt|Trinidad y Tobago|1868;" +
  "tn|Túnez|216;" +
  "tm|Turkmenistán|993;" +
  "tr|Turquía|90;" +
  "tv|Tuvalu|688;" +
  "ua|Ucrania|380;" +
  "ug|Uganda|256;" +
  "uy|Uruguay|598;" +
  "uz|Uzbekistán|998;" +
  "vu|Vanuatu|678;" +
  "ve|Venezuela|58;" +
  "vn|Vietnam|84;" +
  "ye|Yemen|967;" +
  "dj|Yibuti|253;" +
  "zm|Zambia|260;" +
  "zw|Zimbabue|263";

const PAISES_TELEFONO = Object.freeze(
  DATOS_PAISES_TELEFONO.split(";")
    .map((registro) => {
      const [iso, nombre, lada] = registro.split("|");
      return Object.freeze({ iso, nombre, lada });
    })
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es")),
);

const PAISES_DESTACADOS = Object.freeze(["mx", "us"]);
const PAIS_TELEFONO_POR_DEFECTO = "mx";

// Ladas que usan varios países de la lista: se abre en el más común (L56).
const PAIS_PRINCIPAL_POR_LADA = Object.freeze({ 1: "us", 7: "ru", 39: "it" });

const EJEMPLO_TELEFONO_POR_PAIS = Object.freeze({
  mx: "55 1234 5678",
  us: "(201) 555-0123",
  ca: "(204) 555-0123",
  es: "612 34 56 78",
});

function paisTelefono(iso) {
  return (
    PAISES_TELEFONO.find((pais) => pais.iso === iso) ||
    PAISES_TELEFONO.find((pais) => pais.iso === PAIS_TELEFONO_POR_DEFECTO)
  );
}

/*
  "+525512345678" → { iso: "mx", nacional: "5512345678" }. Gana la lada más
  larga que encaje (+1264 es Anguila, no Estados Unidos). Un teléfono viejo
  que no esté en formato internacional abre en México con el texto tal cual:
  así el usuario lo ve y lo corrige, en vez de perderlo.
*/
function separarTelefono(valor) {
  const texto = typeof valor === "string" ? valor.trim() : "";
  const porDefecto = { iso: PAIS_TELEFONO_POR_DEFECTO, nacional: texto };
  const digitos = texto.match(/^\+(\d+)$/);
  if (!digitos) return porDefecto;

  let lada = "";
  PAISES_TELEFONO.forEach((pais) => {
    if (pais.lada.length > lada.length && digitos[1].startsWith(pais.lada)) lada = pais.lada;
  });
  if (!lada) return porDefecto;

  const iso = PAIS_PRINCIPAL_POR_LADA[lada] || PAISES_TELEFONO.find((pais) => pais.lada === lada).iso;
  return { iso, nacional: digitos[1].slice(lada.length) };
}

/*
  País + número → el mismo formato que se guarda hoy (+525512345678), que
  valida PATRON_TELEFONO_PERFIL. Número vacío = sin teléfono. Si el usuario
  escribió el número con su propio "+", se respeta tal cual. Lo que no sea un
  número no se limpia hasta parecerlo: queda como está y la validación lo
  rechaza.
*/
function unirTelefono(iso, nacional) {
  const texto = typeof nacional === "string" ? nacional.trim() : "";
  if (!texto) return "";
  const sinSeparadores = texto.replace(/[\s()\-.]/g, "");
  if (sinSeparadores.startsWith("+")) return sinSeparadores;
  return `+${paisTelefono(iso).lada}${sinSeparadores}`;
}

function normalizarBusquedaPais(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

// Busca por nombre (sin acentos ni mayúsculas) o por lada ("52" o "+52").
function filtrarPaises(consulta) {
  const buscado = normalizarBusquedaPais(consulta).replace(/^\+/, "");
  if (!buscado) return PAISES_TELEFONO.slice();
  return PAISES_TELEFONO.filter(
    (pais) => normalizarBusquedaPais(pais.nombre).includes(buscado) || pais.lada.startsWith(buscado),
  );
}

if (typeof module === "object" && module.exports) {
  module.exports = Object.freeze({
    PAISES_TELEFONO,
    PAISES_DESTACADOS,
    EJEMPLO_TELEFONO_POR_PAIS,
    paisTelefono,
    separarTelefono,
    unirTelefono,
    filtrarPaises,
  });
}
