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

// Factura electrónica del SRI (Ecuador): el XML trae <detalles><detalle> con descripción, cantidad y
// precio unitario. Puede venir envuelto en <autorizacion><comprobante><![CDATA[ … ]]>, con entidades
// escapadas (&lt;…) o en base64.
function decodeXmlText(raw) {
  let x = String(raw || '').trim();
  if (x && !x.startsWith('<') && /^[A-Za-z0-9+/=\s]+$/.test(x)) {
    try { const d = Buffer.from(x, 'base64').toString('utf8'); if (d.includes('<')) x = d; } catch { /* no era base64 */ }
  }
  const cdata = /<comprobante>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/comprobante>/i.exec(x);
  if (cdata) x = cdata[1];
  if (!/<detalle[\s>]/i.test(x) && /&lt;detalle/i.test(x)) {
    x = x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  }
  return x;
}

function sriXmlLines(raw) {
  const x = decodeXmlText(raw);
  const tag = (block, name) => {
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(block);
    return m ? m[1].trim() : null;
  };
  const out = [];
  for (const m of x.matchAll(/<detalle>([\s\S]*?)<\/detalle>/gi)) {
    const b = m[1];
    const qty = Number(tag(b, 'cantidad')) || 1;
    const sinImp = Number(tag(b, 'precioTotalSinImpuesto'));
    const unit = Number(tag(b, 'precioUnitario'));
    out.push({
      description: tag(b, 'descripcion') || tag(b, 'codigoPrincipal') || null,
      quantity: qty,
      // precio neto real de la línea (ya con descuento) repartido por unidad
      unit_price: Number.isFinite(sinImp) && sinImp > 0 ? sinImp / qty : (Number.isFinite(unit) ? unit : 0),
    });
  }
  return out;
}

module.exports = { sriXmlLines, invoicesWithLines, saveLinesOnce, stripeInvoiceLines, stripeChargeLines, alegraLines, factureroLines };
