const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { logAudit } = require('../utils/audit');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// Sincronización de facturas emitidas en Stripe y Alegra hacia el módulo de Facturación del
// CRM. Corre sola cada cierto tiempo (ver scheduler.js) y también se puede disparar a mano
// con los botones "Sincronizar" en Facturación — misma lógica en los dos casos.
// Requiere que el backend tenga sus propias credenciales en variables de entorno de Railway:
//   STRIPE_SECRET_KEY   — Stripe Dashboard → Developers → API keys → Secret key
//   ALEGRA_EMAIL / ALEGRA_TOKEN — cuenta 1 de Alegra (ej. "BIT")
//   ALEGRA_EMAIL_2 / ALEGRA_TOKEN_2 — cuenta 2, opcional (ej. la personal)
//   *_ACCOUNT_NAME — nombre a mostrar para cada cuenta (default si no se define abajo)

async function insertInvoiceTolerant(payload) {
  let body = { ...payload };
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await supabase.from('invoices').insert(body).select().single();
    if (!result.error) return result;
    const match = /Could not find the '(\w+)' column/.exec(result.error.message || '');
    if (!match || !(match[1] in body)) return result;
    delete body[match[1]];
  }
  return { error: { message: 'No se pudo guardar la factura.' } };
}

function stripeStatus(inv) {
  if (inv.status === 'paid') return 'pagada';
  if (inv.status === 'void') return 'cancelada';
  if (inv.amount_paid <= 0) return 'pendiente';
  if (inv.amount_paid < inv.total) return 'parcial';
  return 'pagada';
}

async function syncStripe(actorId) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return { error: 'Falta STRIPE_SECRET_KEY en las variables de entorno de Railway.' };
  const accountName = process.env.STRIPE_ACCOUNT_NAME || 'BitProximity LLC';

  let allInvoices = [];
  let startingAfter;
  for (let page = 0; page < 10; page++) {
    const url = new URL('https://api.stripe.com/v1/invoices');
    url.searchParams.set('limit', '100');
    if (startingAfter) url.searchParams.set('starting_after', startingAfter);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    const data = await r.json();
    if (!r.ok) return { error: data.error?.message || 'Error consultando Stripe' };
    allInvoices = allInvoices.concat(data.data);
    if (!data.has_more) break;
    startingAfter = data.data[data.data.length - 1].id;
  }

  let created = 0, skipped = 0;
  for (const inv of allInvoices) {
    if (inv.status === 'draft') continue;
    const { data: existing } = await supabase.from('invoices').select('id').eq('external_source', 'stripe').eq('external_id', inv.id).maybeSingle();
    if (existing) { skipped++; continue; }

    const name = inv.customer_name || 'Sin nombre';
    const email = inv.customer_email || 'sin email';
    const { error } = await insertInvoiceTolerant({
      invoice_number: inv.number,
      currency: inv.currency.toUpperCase(),
      subtotal: Math.round(inv.subtotal / 100 * 100) / 100,
      tax: Math.round((inv.total - inv.subtotal) / 100 * 100) / 100,
      total: Math.round(inv.total / 100 * 100) / 100,
      paid_amount: Math.round(inv.amount_paid / 100 * 100) / 100,
      status: stripeStatus(inv),
      issue_date: new Date(inv.created * 1000).toISOString().slice(0, 10),
      due_date: inv.due_date ? new Date(inv.due_date * 1000).toISOString().slice(0, 10) : new Date(inv.created * 1000).toISOString().slice(0, 10),
      notes: `Importado de Stripe (${accountName}) - ${name} (${email})`,
      client_name: name === 'Sin nombre' ? null : name,
      source_account: accountName,
      external_source: 'stripe',
      external_id: inv.id,
      created_by: actorId,
    });
    if (!error) created++;
  }

  if (actorId) await logAudit('invoice_sync', null, 'stripe_sync', actorId, { created, skipped });
  return { created, skipped, total_en_stripe: allInvoices.length };
}

function alegraStatus(inv) {
  if (inv.status === 'void' || inv.status === 'closed') return 'cancelada';
  const paid = Number(inv.totalPaid || 0);
  const total = Number(inv.total || 0);
  if (paid <= 0) return 'pendiente';
  if (paid < total) return 'parcial';
  return 'pagada';
}

function alegraAccountsFromEnv() {
  const accounts = [];
  if (process.env.ALEGRA_EMAIL && process.env.ALEGRA_TOKEN) {
    accounts.push({ index: 1, email: process.env.ALEGRA_EMAIL, token: process.env.ALEGRA_TOKEN, name: process.env.ALEGRA_ACCOUNT_NAME || 'BitProximity LLC' });
  }
  if (process.env.ALEGRA_EMAIL_2 && process.env.ALEGRA_TOKEN_2) {
    accounts.push({ index: 2, email: process.env.ALEGRA_EMAIL_2, token: process.env.ALEGRA_TOKEN_2, name: process.env.ALEGRA_ACCOUNT_NAME_2 || 'Cuenta 2' });
  }
  return accounts;
}

async function syncAlegra(actorId) {
  const accounts = alegraAccountsFromEnv();
  if (accounts.length === 0) return { error: 'Falta ALEGRA_EMAIL / ALEGRA_TOKEN en las variables de entorno de Railway.' };

  let totalCreated = 0, totalSkipped = 0, totalSeen = 0;
  const perAccount = [];

  for (const account of accounts) {
    const auth = 'Basic ' + Buffer.from(`${account.email}:${account.token}`).toString('base64');
    let all = [];
    for (let start = 0; start < 3000; start += 30) {
      const r = await fetch(`https://api.alegra.com/api/v1/invoices?limit=30&start=${start}`, { headers: { Authorization: auth } });
      const data = await r.json();
      if (!r.ok) return { error: `${account.name}: ${data.message || 'Error consultando Alegra'}` };
      all = all.concat(data);
      if (data.length < 30) break;
    }

    const sourceKey = `alegra:${account.index}`;
    let created = 0, skipped = 0;
    for (const inv of all) {
      const { data: existing } = await supabase.from('invoices').select('id').eq('external_source', sourceKey).eq('external_id', String(inv.id)).maybeSingle();
      if (existing) { skipped++; continue; }

      const { error } = await insertInvoiceTolerant({
        invoice_number: inv.numberTemplate?.fullNumber || inv.numberTemplate?.formattedNumber || String(inv.id),
        currency: 'COP',
        subtotal: Number(inv.subtotal || 0),
        tax: Number(inv.tax || 0),
        total: Number(inv.total || 0),
        paid_amount: Number(inv.totalPaid || 0),
        status: alegraStatus(inv),
        issue_date: inv.date,
        due_date: inv.dueDate || inv.date,
        notes: `Importado de Alegra (${account.name}) - ${inv.client?.name || 'Sin nombre'}`,
        client_name: inv.client?.name || null,
        source_account: account.name,
        external_source: sourceKey,
        external_id: String(inv.id),
        created_by: actorId,
      });
      if (!error) created++;
    }

    perAccount.push({ account: account.name, created, skipped, total_en_alegra: all.length });
    totalCreated += created;
    totalSkipped += skipped;
    totalSeen += all.length;
  }

  if (actorId) await logAudit('invoice_sync', null, 'alegra_sync', actorId, { created: totalCreated, skipped: totalSkipped, per_account: perAccount });
  return { created: totalCreated, skipped: totalSkipped, total_en_alegra: totalSeen, per_account: perAccount };
}

router.post('/stripe', requireRole('admin'), async (req, res) => {
  const result = await syncStripe(req.teamMember.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

router.post('/alegra', requireRole('admin'), async (req, res) => {
  const result = await syncAlegra(req.teamMember.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

module.exports = router;
module.exports.syncStripe = syncStripe;
module.exports.syncAlegra = syncAlegra;
