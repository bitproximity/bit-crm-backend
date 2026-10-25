// Las sincronizaciones de facturas (Stripe, Alegra, Facturero Móvil) corren cada 15 minutos y al
// arrancar. Antes preguntaban a la base UNA POR UNA si cada factura ya existía (más de 1,4 millones
// de consultas acumuladas, casi todas para facturas que ya estaban). Ahora se trae de una vez la lista
// de lo que ya existe por fuente (unas pocas consultas) y solo se insertan las que faltan.
const supabase = require('../config/supabase');
const { fetchAll } = require('./fetchAll');

async function knownExternalIds(source) {
  const { data, error } = await fetchAll(supabase.from('invoices').select('external_id').eq('external_source', source));
  if (error) throw new Error(`No se pudieron leer las facturas ya sincronizadas de "${source}": ${error.message}`);
  return new Set((data || []).map((r) => String(r.external_id)));
}

// Igual que arriba pero con lo necesario para decidir si una factura ya sincronizada cambió en el origen.
async function knownExternalInvoices(source) {
  const { data, error } = await fetchAll(supabase.from('invoices').select('id, external_id, status, paid_amount, total, due_date, currency, invoice_number').eq('external_source', source));
  if (error) throw new Error(`No se pudieron leer las facturas ya sincronizadas de "${source}": ${error.message}`);
  return new Map((data || []).map((r) => [String(r.external_id), r]));
}

module.exports = { knownExternalIds, knownExternalInvoices };
