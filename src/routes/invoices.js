const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

function withOverdueFlag(inv) {
  const overdue = inv.status !== 'pagada' && inv.status !== 'cancelada' && inv.due_date && inv.due_date < new Date().toISOString().slice(0, 10);
  return { ...inv, overdue };
}

// GET /api/invoices?deal_id=&company_id=&status=
router.get('/', async (req, res) => {
  const { deal_id, company_id, status } = req.query;

  let query = supabase
    .from('invoices')
    .select('*, deals(title), companies(name), contacts(first_name,last_name)')
    .order('issue_date', { ascending: false });

  if (deal_id) query = query.eq('deal_id', deal_id);
  if (company_id) query = query.eq('company_id', company_id);
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(withOverdueFlag));
});

// GET /api/invoices/summary — totales para las tarjetas de resumen
router.get('/summary', async (req, res) => {
  const { data, error } = await supabase.from('invoices').select('total, paid_amount, status, due_date, currency');
  if (error) return res.status(500).json({ error: error.message });

  const today = new Date().toISOString().slice(0, 10);
  const summary = { total_facturado: 0, total_cobrado: 0, total_pendiente: 0, total_vencido: 0, count: data.length };

  data.forEach((inv) => {
    summary.total_facturado += Number(inv.total || 0);
    summary.total_cobrado += Number(inv.paid_amount || 0);
    const pending = Number(inv.total || 0) - Number(inv.paid_amount || 0);
    if (inv.status !== 'pagada' && inv.status !== 'cancelada') {
      summary.total_pendiente += pending;
      if (inv.due_date && inv.due_date < today) summary.total_vencido += pending;
    }
  });

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
router.post('/', async (req, res) => {
  const { line_items = [], tax = 0, ...invoiceFields } = req.body;

  const subtotal = line_items.reduce((sum, li) => sum + Number(li.quantity || 1) * Number(li.unit_price || 0), 0);
  const total = subtotal + Number(tax || 0);

  const { data: invoice, error } = await supabase
    .from('invoices')
    .insert({ ...invoiceFields, subtotal, tax, total, created_by: req.teamMember.id })
    .select()
    .single();

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
