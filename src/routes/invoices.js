const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { requirePage } = require('../middleware/pagePermissions');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);
router.use(requirePage('__admin_only__'));

function withOverdueFlag(inv) {
  const overdue = inv.status !== 'pagada' && inv.status !== 'cancelada' && inv.due_date && inv.due_date < new Date().toISOString().slice(0, 10);
  return { ...inv, overdue };
}

// GET /api/invoices?deal_id=&company_id=&status=
router.get('/', async (req, res) => {
  const { deal_id, company_id, status, offset, year, month, source_account, q } = req.query;

  let query = supabase
    .from('invoices')
    .select('*, deals(title), companies(name), contacts(first_name,last_name)')
    .order('issue_date', { ascending: false })
    .order('id', { ascending: true }); // desempate estable — sin esto, .range() puede repetir u omitir filas cuando muchas comparten la misma fecha

  if (deal_id) query = query.eq('deal_id', deal_id);
  if (company_id) query = query.eq('company_id', company_id);
  if (status) query = query.eq('status', status);
  if (source_account) query = query.eq('source_account', source_account);
  // Búsqueda libre por razón social o número de factura — para revisar/confirmar rápido
  // sin tener que acordarse del número exacto.
  if (q) query = query.or(`client_name.ilike.%${q}%,invoice_number.ilike.%${q}%`);
  // month (YYYY-MM) es más específico que year (YYYY) — si vienen los dos, gana month.
  if (month) {
    const [y, m] = month.split('-').map(Number);
    const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
    query = query.gte('issue_date', `${month}-01`).lt('issue_date', nextMonth);
  } else if (year) {
    query = query.gte('issue_date', `${year}-01-01`).lt('issue_date', `${Number(year) + 1}-01-01`);
  }
  // Supabase limita a 1000 filas por defecto sin avisar — con muchas fuentes sincronizadas
  // (Stripe/Alegra/Facturero Móvil) ya se superó ese número, así que se pagina con offset.
  const start = Number(offset) || 0;
  query = query.range(start, start + 999);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(withOverdueFlag));
});

// GET /api/invoices/summary — totales para las tarjetas de resumen
router.get('/summary', async (req, res) => {
  const [{ data, error }, { data: rates }] = await Promise.all([
    supabase.from('invoices').select('total, paid_amount, status, due_date, issue_date, currency, source_account, client_name'),
    supabase.from('exchange_rates').select('*'),
  ]);
  if (error) return res.status(500).json({ error: error.message });

  // Todo se convierte a USD antes de sumar — antes se sumaban montos de monedas distintas
  // (USD + COP) directo, lo que daba un total sin sentido real.
  const rateMap = Object.fromEntries((rates || []).map((r) => [r.currency, Number(r.rate_to_usd)]));
  const toUsd = (value, currency) => Number(value || 0) * (rateMap[currency] ?? 1);

  const today = new Date().toISOString().slice(0, 10);
  const summary = { total_facturado: 0, total_cobrado: 0, total_pendiente: 0, total_vencido: 0, count: data.length };

  // Por empresa/cuenta que facturó (BitProximity LLC, BIT Colombia SAS, Diana Sanchez, etc.)
  const byAccount = {};
  // Por mes de emisión (YYYY-MM), últimos 12 meses con datos
  const byMonth = {};
  // Antigüedad de cartera pendiente — cuántos días vencida, agrupado en tramos clásicos
  const aging = { al_dia: 0, '1_30': 0, '31_60': 0, '61_90': 0, mas_90: 0 };

  data.forEach((inv) => {
    const totalUsd = toUsd(inv.total, inv.currency);
    const paidUsd = toUsd(inv.paid_amount, inv.currency);
    const pendingUsd = totalUsd - paidUsd;
    const isOpen = inv.status !== 'pagada' && inv.status !== 'cancelada';

    summary.total_facturado += totalUsd;
    summary.total_cobrado += paidUsd;

    const accountKey = inv.source_account || 'Manual / sin origen';
    if (!byAccount[accountKey]) byAccount[accountKey] = { facturado: 0, cobrado: 0, pendiente: 0 };
    byAccount[accountKey].facturado += totalUsd;
    byAccount[accountKey].cobrado += paidUsd;

    if (inv.issue_date) {
      const month = inv.issue_date.slice(0, 7);
      if (!byMonth[month]) byMonth[month] = { facturado: 0, cobrado: 0 };
      byMonth[month].facturado += totalUsd;
      byMonth[month].cobrado += paidUsd;
    }

    if (isOpen) {
      summary.total_pendiente += pendingUsd;
      byAccount[accountKey].pendiente += pendingUsd;
      if (inv.due_date && inv.due_date < today) {
        summary.total_vencido += pendingUsd;
        const daysLate = Math.floor((new Date(today) - new Date(inv.due_date)) / 86400000);
        if (daysLate <= 30) aging['1_30'] += pendingUsd;
        else if (daysLate <= 60) aging['31_60'] += pendingUsd;
        else if (daysLate <= 90) aging['61_90'] += pendingUsd;
        else aging.mas_90 += pendingUsd;
      } else {
        aging.al_dia += pendingUsd;
      }
    }
  });

  const round = (n) => Math.round(n * 100) / 100;
  ['total_facturado', 'total_cobrado', 'total_pendiente', 'total_vencido'].forEach((k) => { summary[k] = round(summary[k]); });
  Object.keys(aging).forEach((k) => { aging[k] = round(aging[k]); });

  summary.by_account = Object.entries(byAccount)
    .map(([name, v]) => ({ name, facturado: round(v.facturado), cobrado: round(v.cobrado), pendiente: round(v.pendiente) }))
    .sort((a, b) => b.facturado - a.facturado);

  summary.by_month = Object.entries(byMonth)
    .map(([month, v]) => ({ month, facturado: round(v.facturado), cobrado: round(v.cobrado) }))
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-12);

  summary.aging = aging;

  res.json(summary);
});

// GET /api/invoices/:id — factura completa con líneas y pagos
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const [{ data: invoice, error }, { data: lineItems }, { data: payments }] = await Promise.all([
    supabase.from('invoices').select('*, deals(title), companies(*), contacts(*)').eq('id', id).single(),
    supabase.from('invoice_line_items').select('*, products(name)').eq('invoice_id', id).order('created_at'),
    supabase.from('invoice_payments').select('*, team_members(full_name)').eq('invoice_id', id).order('paid_at', { ascending: false }),
  ]);

  if (error) return res.status(404).json({ error: 'Factura no encontrada' });
  res.json({ ...withOverdueFlag(invoice), line_items: lineItems, payments });
});

// POST /api/invoices  { deal_id?, company_id?, contact_id?, currency, due_date?, notes?, line_items: [{product_id?, description, quantity, unit_price}], tax? }
// Si un campo nuevo (ej. external_source/external_id de una migración que Mario todavía no
// corrió) no existe en la tabla, antes esto tumbaba la creación ENTERA de la factura. Mismo
// blindaje que ya tienen deals.js y b2b.js: se detecta, se saca ese campo puntual, se reintenta.
async function insertInvoiceTolerant(payload) {
  let body = { ...payload };
  const skipped = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await supabase.from('invoices').insert(body).select().single();
    if (!result.error) return { ...result, skipped };
    const match = /column "?(\w+)"? of relation "invoices" does not exist|Could not find the '(\w+)' column/.exec(result.error.message || '');
    const col = match?.[1] || match?.[2];
    if (!col || !(col in body)) return result;
    skipped.push(col);
    delete body[col];
  }
  return { error: { message: 'No se pudo guardar la factura después de varios intentos.' } };
}

router.post('/', async (req, res) => {
  const { line_items = [], tax = 0, ...invoiceFields } = req.body;

  const subtotal = line_items.reduce((sum, li) => sum + Number(li.quantity || 1) * Number(li.unit_price || 0), 0);
  const total = subtotal + Number(tax || 0);

  const { data: invoice, error } = await insertInvoiceTolerant({ ...invoiceFields, subtotal, tax, total, created_by: req.teamMember.id });

  if (error) return res.status(400).json({ error: error.message });

  if (line_items.length > 0) {
    const rows = line_items.map((li) => ({
      invoice_id: invoice.id,
      product_id: li.product_id || null,
      description: li.description || null,
      quantity: Number(li.quantity || 1),
      unit_price: Number(li.unit_price || 0),
    }));
    const { error: liError } = await supabase.from('invoice_line_items').insert(rows);
    if (liError) return res.status(400).json({ error: liError.message });
  }

  await logAudit('invoice', invoice.id, 'created', req.teamMember.id);
  res.status(201).json(invoice);
});

// PATCH /api/invoices/:id — editar campos generales (no líneas ni pagos)
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('invoices')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  await logAudit('invoice', id, 'updated', req.teamMember.id, { fields: Object.keys(req.body) });
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('invoices').delete().eq('id', id);
  if (error) return res.status(400).json({ error: error.message });
  await logAudit('invoice', id, 'deleted', req.teamMember.id);
  res.status(204).send();
});

async function recomputeInvoiceTotals(invoiceId) {
  const [{ data: invoice }, { data: lineItems }] = await Promise.all([
    supabase.from('invoices').select('tax, paid_amount').eq('id', invoiceId).single(),
    supabase.from('invoice_line_items').select('quantity, unit_price').eq('invoice_id', invoiceId),
  ]);
  const subtotal = (lineItems || []).reduce((sum, li) => sum + Number(li.quantity) * Number(li.unit_price), 0);
  const total = subtotal + Number(invoice?.tax || 0);
  const newStatus = Number(invoice?.paid_amount || 0) >= total && total > 0 ? 'pagada' : Number(invoice?.paid_amount || 0) > 0 ? 'parcial' : undefined;
  const update = { subtotal, total, updated_at: new Date().toISOString() };
  if (newStatus) update.status = newStatus;
  await supabase.from('invoices').update(update).eq('id', invoiceId);
}

// POST /api/invoices/:id/line-items  { product_id?, description, quantity, unit_price }
router.post('/:id/line-items', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('invoice_line_items')
    .insert({ invoice_id: id, ...req.body })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  await recomputeInvoiceTotals(id);
  res.status(201).json(data);
});

// PATCH /api/invoices/:id/line-items/:itemId  { description?, quantity?, unit_price?, product_id? }
router.patch('/:id/line-items/:itemId', async (req, res) => {
  const { id, itemId } = req.params;
  const { data, error } = await supabase
    .from('invoice_line_items')
    .update(req.body)
    .eq('id', itemId)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  await recomputeInvoiceTotals(id);
  res.json(data);
});

// DELETE /api/invoices/:id/line-items/:itemId
router.delete('/:id/line-items/:itemId', async (req, res) => {
  const { id, itemId } = req.params;
  const { error } = await supabase.from('invoice_line_items').delete().eq('id', itemId);
  if (error) return res.status(400).json({ error: error.message });
  await recomputeInvoiceTotals(id);
  res.status(204).send();
});

// POST /api/invoices/:id/payments  { amount, method?, notes?, paid_at? }
// Registra un pago (parcial o total) y recalcula el estado de la factura.
router.post('/:id/payments', async (req, res) => {
  const { id } = req.params;
  const { amount, method, notes, paid_at } = req.body;
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a 0' });

  const { data: invoice } = await supabase.from('invoices').select('*').eq('id', id).single();
  if (!invoice) return res.status(404).json({ error: 'Factura no encontrada' });

  const { data: payment, error } = await supabase
    .from('invoice_payments')
    .insert({ invoice_id: id, amount: Number(amount), method: method || null, notes: notes || null, paid_at: paid_at || new Date().toISOString(), recorded_by: req.teamMember.id })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  const newPaidAmount = Number(invoice.paid_amount || 0) + Number(amount);
  const newStatus = newPaidAmount >= Number(invoice.total) ? 'pagada' : 'parcial';

  const { data: updatedInvoice } = await supabase
    .from('invoices')
    .update({ paid_amount: newPaidAmount, status: newStatus, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  await logAudit('invoice', id, 'updated', req.teamMember.id, { fields: ['payment'] });
  res.status(201).json({ payment, invoice: updatedInvoice });
});

router.delete('/:id/payments/:paymentId', async (req, res) => {
  const { id, paymentId } = req.params;
  const { data: payment } = await supabase.from('invoice_payments').select('*').eq('id', paymentId).single();
  if (!payment) return res.status(404).json({ error: 'Pago no encontrado' });

  const { error } = await supabase.from('invoice_payments').delete().eq('id', paymentId);
  if (error) return res.status(400).json({ error: error.message });

  const { data: invoice } = await supabase.from('invoices').select('*').eq('id', id).single();
  const newPaidAmount = Math.max(0, Number(invoice.paid_amount || 0) - Number(payment.amount));
  const newStatus = newPaidAmount >= Number(invoice.total) ? 'pagada' : newPaidAmount > 0 ? 'parcial' : 'pendiente';

  await supabase.from('invoices').update({ paid_amount: newPaidAmount, status: newStatus, updated_at: new Date().toISOString() }).eq('id', id);
  res.status(204).send();
});

module.exports = router;
