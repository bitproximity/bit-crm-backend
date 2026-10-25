// Conversión a USD con las tasas del día (tabla exchange_rates: «cuántos USD vale 1 unidad de la moneda»).
//
// Antes cada ruta (facturas, dashboard, métricas, forecast, insights, MCP) tenía su propia copia de
//   rateMap[moneda] ?? 1
// y una moneda SIN tasa se sumaba 1 a 1 con dólares: 5.000.000 de guaraníes contaban como USD 5.000.000.
// Aquí una moneda sin tasa suma 0 y queda anotada en `missing`, para poder AVISARLO en pantalla en vez de
// inflar o desinflar las cifras en silencio.
function buildConverter(rates = []) {
  const map = new Map();
  let updatedAt = null;
  for (const r of rates || []) {
    const rate = Number(r.rate_to_usd);
    if (r.currency && rate > 0) map.set(String(r.currency).toUpperCase(), rate);
    if (r.updated_at && (!updatedAt || r.updated_at > updatedAt)) updatedAt = r.updated_at;
  }
  map.set('USD', 1);
  const missing = new Set();

  const toUsd = (value, currency) => {
    const code = String(currency || 'USD').toUpperCase();
    const rate = map.get(code);
    if (rate === undefined) { missing.add(code); return 0; }
    return Number(value || 0) * rate;
  };
  return {
    toUsd,
    hasRate: (currency) => map.has(String(currency || 'USD').toUpperCase()),
    missing,
    updatedAt,
    currencies: [...map.keys()].sort(),
  };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

module.exports = { buildConverter, round2 };
