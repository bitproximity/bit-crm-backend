// Lo COBRADO (facturas, no tratos) por producto y por país, en USD.
// Producto: del detalle de cada factura (línea → producto del catálogo o palabra clave). El cobro de
// la factura se reparte entre sus líneas según el peso de cada una.
// País: el de la empresa vinculada; si la factura no está vinculada, el de la empresa que facturó.
const ACCOUNT_COUNTRY = {
  'Diana Sánchez': 'Ecuador',
  'Mario Ramos': 'Ecuador',
  'Mario Colombia': 'Colombia',
  'Bit Colombia SAS': 'Colombia',
  'Bit Paraguay EAS': 'Paraguay',
  'Bit México': 'México',
  'BitProximity LLC': 'Internacional (Stripe / LLC)',
};

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function productFromText(text, catalogNames) {
  const t = norm(text);
  if (!t) return null;
  const hit = catalogNames.find((n) => n.key && t.includes(n.key));
  if (hit) return hit.name;
  if (/whatsapp/.test(t)) return 'WhatsApp Marketing';
  if (/e-?mail|mailing/.test(t)) return 'Email Marketing';
  if (/wi-?fi|wi fi|hotspot|internet/.test(t)) return 'Bit WiFi';
  if (/music|musica|radio|audio/.test(t)) return 'Bit Music';
  if (/signage|cartel|pantalla|screen/.test(t)) return 'Bit Signage';
  if (/prospec|reunion|citas|appointment|lead/.test(t)) return 'Bit Prospect';
  if (/router|equipo|access point|hardware|antena/.test(t)) return 'Equipos (hardware)';
  return null;
}

function buildRevenueBreakdown({ invoices, lines, products, companiesById, converter }) {
  const catalogNames = (products || [])
    .map((p) => ({ name: p.name, key: norm(p.name) }))
    .filter((p) => p.key.length >= 4)
    .sort((a, b) => b.key.length - a.key.length);
  const productById = new Map((products || []).map((p) => [p.id, p.name]));
  const linesByInvoice = new Map();
  for (const l of lines || []) {
    if (!linesByInvoice.has(l.invoice_id)) linesByInvoice.set(l.invoice_id, []);
    linesByInvoice.get(l.invoice_id).push(l);
  }

  const byProduct = new Map();
  const byCountry = new Map();
  const byCountryProduct = new Map();
  let total = 0, withDetail = 0;
  const add = (map, key, usd) => map.set(key, (map.get(key) || 0) + usd);

  for (const inv of invoices || []) {
    if (inv.status === 'cancelada') continue;
    const paid = converter.toUsd(Number(inv.paid_amount || 0), inv.currency);
    if (!(paid > 0)) continue;
    total += paid;
    const company = inv.company_id ? companiesById.get(inv.company_id) : null;
    const country = (company?.country || '').trim() || ACCOUNT_COUNTRY[inv.source_account] || `Sin país (${inv.source_account || 'sin empresa'})`;
    add(byCountry, country, paid);

    const ls = linesByInvoice.get(inv.id) || [];
    const amounts = ls.map((l) => Math.max(Number(l.quantity || 1) * Number(l.unit_price || 0), 0));
    const sum = amounts.reduce((a, b) => a + b, 0);
    if (!ls.length) { add(byProduct, 'Sin detalle de productos', paid); add(byCountryProduct, `${country}|Sin detalle de productos`, paid); continue; }
    withDetail += paid;
    ls.forEach((l, i) => {
      const share = sum > 0 ? amounts[i] / sum : 1 / ls.length;
      const usd = paid * share;
      const product = (l.product_id && productById.get(l.product_id)) || productFromText(l.description, catalogNames) || 'Otros servicios';
      add(byProduct, product, usd);
      add(byCountryProduct, `${country}|${product}`, usd);
    });
  }

  const r2 = (n) => Math.round(n);
  const toRows = (map) => [...map.entries()].map(([name, usd]) => ({ name, usd: r2(usd), pct: total ? Math.round((usd / total) * 1000) / 10 : 0 })).sort((a, b) => b.usd - a.usd);
  const topByCountry = {};
  for (const [key, usd] of byCountryProduct) {
    const [country, product] = key.split('|');
    (topByCountry[country] ||= []).push({ product, usd: r2(usd) });
  }
  return {
    total_usd: r2(total),
    detail_coverage_pct: total ? Math.round((withDetail / total) * 1000) / 10 : 0,
    by_product: toRows(byProduct),
    by_country: toRows(byCountry).map((c) => ({ ...c, top_products: (topByCountry[c.name] || []).sort((a, b) => b.usd - a.usd).slice(0, 3) })),
  };
}

module.exports = { buildRevenueBreakdown, productFromText, ACCOUNT_COUNTRY };
