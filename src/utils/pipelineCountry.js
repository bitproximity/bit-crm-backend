// Pipelines cuyo nombre ya indica un país puntual — se usa para inferir el país de un
// trato cuando su empresa no tiene el campo país cargado. Pipelines multi-país (WiFi
// Marketing, Neomedia, BIT MUSIC, Omnicanalidad) no están acá a propósito: no hay país
// que inferir de ellos.
const PIPELINE_COUNTRY = {
  'Bit Colombia': 'Colombia',
  'Bit México': 'México',
  'Bit Ecuador': 'Ecuador',
  'Bit RD': 'República Dominicana',
  'Bit Panamá': 'Panamá',
  'Bit LLC': 'Estados Unidos',
  'Bit Paraguay': 'Paraguay',
  'Bit Perú': 'Perú',
};

// Mismo criterio en un solo lugar: país de la empresa si lo tiene, si no el del
// pipeline (cuando aplica), si no "Sin especificar". Se usa tanto para el ranking de
// Métricas como para el filtro de deals por país — así los números y el detalle
// siempre cuadran entre sí.
function resolveDealCountry(companyCountry, pipelineName) {
  const c = companyCountry?.trim();
  if (c) return c;
  return PIPELINE_COUNTRY[pipelineName] || 'Sin especificar';
}

module.exports = { PIPELINE_COUNTRY, resolveDealCountry };
