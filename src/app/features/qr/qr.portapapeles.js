/*
  Copiar con un clic en las tablas de QR ("Mis QR" y la moderación). Vive
  aparte de qr.nucleo.js porque toca el DOM y el portapapeles, y el núcleo es
  lógica pura que también corre en Node.
*/

// Selecciona el nodo entero (aunque se vea cortado con «…») y copia `texto`.
// Si el navegador no deja escribir en el portapapeles, al menos queda
// seleccionado para copiarlo a mano. Devuelve si se copió.
async function copiarSeleccionandoQR(nodo, texto) {
  if (nodo instanceof HTMLInputElement) {
    nodo.select();
  } else {
    const rango = document.createRange();
    rango.selectNodeContents(nodo);
    const seleccion = window.getSelection();
    seleccion.removeAllRanges();
    seleccion.addRange(rango);
  }
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    return false;
  }
}

// El toast de "copiado" es el mismo en las dos páginas: `que` es "Link" o
// "Link del QR".
async function copiarConAvisoQR(nodo, texto, que) {
  mostrarToast(await copiarSeleccionandoQR(nodo, texto)
    ? `${que} copiado.`
    : `${que} quedó seleccionado: cópialo con Ctrl+C o desde el menú del celular.`);
}
