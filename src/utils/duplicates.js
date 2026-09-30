// Normaliza un nombre de empresa para comparar: sin acentos, sin mayúsculas, sin
// sufijos legales comunes (SAS, LLC, S.A., etc.) y sin puntuación — así "Bit Colombia
// SAS" y "BIT COLOMBIA S.A.S." se reconocen como la misma empresa.
const LEGAL_SUFFIXES = /\b(s\.?a\.?s\.?|s\.?a\.?|s\.?r\.?l\.?|ltda\.?|llc|inc\.?|corp\.?|co\.?|c\.?a\.?|group|grupo)\b/gi;

function normalizeCompanyName(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Nombre completo de un contacto, normalizado (sin acentos, sin mayúsculas, un solo
// espacio entre palabras).
function normalizeContactName(first, last) {
  return `${first || ''} ${last || ''}`
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

module.exports = { normalizeCompanyName, normalizeContactName, normalizeEmail };
