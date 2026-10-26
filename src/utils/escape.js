// Utilidades de seguridad para texto que escribe una persona (o un visitante anónimo).

// HTML: todo lo que se inserta en un correo o página como texto debe pasar por aquí, para que «<a href=…>» sea texto y no un enlace.
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Búsquedas con .or('campo.ilike.%texto%,…') / .ilike(): la coma, los paréntesis y las comillas son SINTAXIS del filtro; si vienen en el
// texto de búsqueda, quien busca podría agregar condiciones propias. Se cambian por espacios, y los comodines (% _) se escapan para que
// «50%» busque «50%» y no «todo».
function escapeLike(value) {
  return String(value ?? '')
    .replace(/[,()"'`\\]/g, ' ')
    .replace(/[%_]/g, (m) => `\\${m}`)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

// Para .ilike('campo', valor) (el valor va aparte, no dentro de una cadena de filtros): la puntuación es inofensiva y debe conservarse
// («Acme, Inc.» tiene que encontrar «Acme, Inc.»); solo los comodines de LIKE (% _) y la barra se escapan para que sea una igualdad exacta.
function escapeIlikeValue(value) {
  return String(value ?? '').replace(/[\\%_]/g, (m) => `\\${m}`);
}

module.exports = { escapeHtml, escapeLike, escapeIlikeValue };
