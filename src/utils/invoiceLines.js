// Detalle (líneas de producto) de las facturas que llegan solas desde Alegra, Stripe y Facturero
// Móvil. Antes solo se guardaba el total: no se podía saber QUÉ se vendió (ni cuánto se cobra por
// producto). Se guardan las líneas una sola vez por factura: si ya tiene líneas, no se tocan.
const supabase = require('../config/supabase');
const { fetchAll } = require('./fetchAll');

// IDs de facturas que ya tienen líneas (una consulta por sincronización)
async function invoicesWithLines() {
  const { data, error } = await fetchAll(supabase.from('invoice_line_items').select('invoice_id'), ['invoice_id', 'id']);
  if (error) throw new Error(`No se pudieron leer las líneas de factura: ${error.message}`);
  return new Set((data || []).map((r) => r.invoice_id));
}

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// Guarda las líneas de una factura si todavía no tiene. lines: [{ description, quantity, unit_price }]
async function saveLinesOnce(invoiceId, lines, withLines) {
  if (!invoiceId || withLines.has(invoiceId)) return 0;
  const rows = (lines || [])
    .filter((l) => l && (l.description || Number(l.unit_price)))
    .map((l) => ({
      invoice_id: invoiceId,
      description: String(l.description || '').trim().slice(0, 500) || null,
      quantity: Number(l.quantity) > 0 ? Number(l.quantity) : 1,
      unit_price: round2(l.unit_price),
    }));
  if (!rows.length) return 0;
  const { error } = await supabase.from('invoice_line_items').insert(rows);
  if (error) return 0;
  withLines.add(invoiceId);
  return rows.length;
}

// ── Formatos de cada fuente → { description, quantity, unit_price } ──
function stripeInvoiceLines(inv) {
  return (inv.lines?.data || []).map((l) => {
    const qty = Number(l.quantity) > 0 ? Number(l.quantity) : 1;
    return { description: l.description || l.price?.nickname || l.plan?.nickname || null, quantity: qty, unit_price: Number(l.amount || 0) / 100 / qty };
  });
}

function stripeChargeLines(ch) {
  const amount = Number(ch.amount_captured ?? ch.amount ?? 0) / 100;
  return [{ description: ch.description || ch.calculated_statement_descriptor || 'Cobro de Stripe', quantity: 1, unit_price: amount }];
}

function alegraLines(inv) {
  return (inv.items || []).map((it) => {
    const name = [it.name, it.description && it.description !== it.name ? it.description : null].filter(Boolean).join(' — ');
    return { description: name || null, quantity: Number(it.quantity) || 1, unit_price: Number(it.price || 0) };
  });
}

// Facturero Móvil: la API no documenta el detalle; se aceptan los nombres de campo más comunes.
function factureroLines(doc) {
  const arr = doc.detalles || doc.detalle || doc.items || doc.productos || doc.detalleFactura || [];
  if (!Array.isArray(arr)) return [];
  return arr.map((d) => ({
    description: d.descripcion || d.description || d.nombre || d.producto || d.detalle || null,
    quantity: Number(d.cantidad ?? d.quantity) || 1,
    unit_price: Number(d.precioUnitario ?? d.precio_unitario ?? d.precio ?? d.price ?? d.valorUnitario ?? 0),
  }));
}

module.exports = { invoicesWithLines, saveLinesOnce, stripeInvoiceLines, stripeChargeLines, alegraLines, factureroLines };
