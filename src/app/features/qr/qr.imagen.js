/*
  Las imágenes del QR en el navegador: el SVG de las tarjetas y las dos
  descargas. Depende de qrcode-generator (global `qrcode`, desde jsDelivr con
  SRI) y de qr.nucleo.js, que decide TODA la geometría: trazosQR() devuelve los
  trazos una vez, y el SVG y el PNG los pintan igual.

  POR QUÉ EL PNG SE PINTA CON Path2D en un canvas y no rasterizando el SVG:
  dibujar una imagen SVG sobre un canvas puede "mancharlo" en algunos
  navegadores (Safari, históricamente), y un canvas manchado ya no deja
  exportar. Los mismos trazos como Path2D no tienen nada que manchar, y el
  isotipo es vector: no hay imagen que cargar.
*/

// El lado mínimo del PNG. Se redondea hacia arriba a un múltiplo del QR para
// que cada módulo mida un número entero de píxeles.
const ANCHO_MINIMO_PNG_QR = 1024;

// qrcode-generator codifica por defecto cada carácter como un solo byte: una
// "ñ" en el nombre de una red salía ilegible. Los links cortos son ASCII, así
// que en ellos UTF-8 da exactamente los mismos bytes.
qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"];

function matrizQR(texto) {
  const qr = qrcode(0, "H");
  qr.addData(texto);
  qr.make();
  return { n: qr.getModuleCount(), esOscuro: (fila, col) => qr.isDark(fila, col) };
}

// Cualquier texto como QR: el link corto de un QR de enlace o el WIFI:… de uno
// de Wi‑Fi (qr.nucleo.js). Los "DeCodigo" son el caso del link corto.
function svgQRDeTexto(texto, etiqueta) {
  const { n, esOscuro } = matrizQR(texto);
  return svgQR({ n, esOscuro, etiqueta });
}

function svgQRDeCodigo(codigo) {
  return svgQRDeTexto(urlCortaQR(codigo), `Código QR de ${urlVisibleQR(codigo)}`);
}

function descargarArchivoQR(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = nombre;
  document.body.append(enlace);
  enlace.click();
  enlace.remove();
  // Revocar en el mismo tick puede cortar la descarga en algunos navegadores.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function descargarSvgQR(codigo) {
  descargarArchivoQR(new Blob([svgQRDeCodigo(codigo)], { type: "image/svg+xml" }), `qr-${codigo}.svg`);
}

async function descargarPngQR(codigo) {
  descargarArchivoQR(await pngQRBlob(codigo), `qr-${codigo}.png`);
}

// La descarga de un QR que no tiene código (el de Wi‑Fi): `base` es el nombre
// del archivo sin extensión.
async function descargarQRDeTexto(texto, etiqueta, base, formato) {
  if (formato === "svg") {
    descargarArchivoQR(new Blob([svgQRDeTexto(texto, etiqueta)], { type: "image/svg+xml" }), `${base}.svg`);
  } else {
    descargarArchivoQR(await pngQRBlobDeTexto(texto), `${base}.png`);
  }
}

async function pngQRBlob(codigo) {
  return pngQRBlobDeTexto(urlCortaQR(codigo));
}

// PNG con las esquinas de la tarjeta transparentes: sobre una hoja blanca no
// se nota, y sobre un fondo oscuro la tarjeta blanca da el contraste. Lo usan
// la descarga y "Compartir" (que lo manda como archivo donde se puede).
async function pngQRBlobDeTexto(texto) {
  const { n, esOscuro } = matrizQR(texto);
  const trazos = trazosQR(n, esOscuro);
  const escala = Math.ceil(ANCHO_MINIMO_PNG_QR / trazos.total);
  const lienzo = document.createElement("canvas");
  lienzo.width = trazos.total * escala;
  lienzo.height = trazos.total * escala;
  const contexto = lienzo.getContext("2d");
  contexto.scale(escala, escala);

  const pintar = (color, trazo, regla = "nonzero") => {
    contexto.fillStyle = color;
    contexto.fill(new Path2D(trazo), regla);
  };
  pintar("#fff", trazos.tarjeta);
  pintar(QR_TINTA, trazos.modulos);
  pintar(QR_AZUL, trazos.ojos, "evenodd");
  pintar(QR_TINTA, trazos.alineacion, "evenodd");

  const { cx, cy, radio, radioInterno } = trazos.insignia;
  const disco = (r) => {
    const trazo = new Path2D();
    trazo.arc(cx, cy, r, 0, Math.PI * 2);
    return trazo;
  };
  contexto.fillStyle = "#fff";
  contexto.fill(disco(radio));
  // El mismo borde fino que el <circle stroke> del SVG.
  contexto.strokeStyle = QR_BORDE_INSIGNIA;
  contexto.lineWidth = 0.18;
  contexto.stroke(disco(radioInterno));

  contexto.save();
  contexto.translate(trazos.isotipo.x, trazos.isotipo.y);
  contexto.scale(trazos.isotipo.escala, trazos.isotipo.escala);
  for (const { puntos, color } of QR_ISOTIPO) {
    contexto.fillStyle = color;
    contexto.fill(new Path2D(`M${puntos.split(" ").join("L")}Z`));
  }
  contexto.restore();

  return new Promise((resolver, rechazar) => {
    lienzo.toBlob((resultado) => (resultado ? resolver(resultado) : rechazar(new Error("toBlob vacío"))), "image/png");
  });
}
