const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { dateInTz } = require('../utils/businessDate');
const { logAudit } = require('../utils/audit');
const { requireAuth, requireRole } = require('../middleware/auth');
const { knownExternalInvoices } = require('../utils/knownExternalIds');
const { mergeIncoming } = require('../utils/invoiceMerge');
const { round2 } = require('../utils/currency');
const syncStatus = require('../utils/syncStatus');
const { clearAll: clearMemo } = require('../utils/memo');
const { canonicalAccountName, alegraOriginFor } = require('../utils/accountNames');

router.use(requireAuth);
router.use(require('../middleware/pagePermissions').requirePage('facturacion'));

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

// Alinea una factura que YA existe en el CRM con lo que trae el origen (ver utils/invoiceMerge.js para la regla).
// Devuelve { updated, discrepancy }. Un cobro nuevo en el origen también queda como pago en el historial de la
// factura, para que «días de cobro» y los cobros del mes salgan bien.
// Los cobros se registran A MANO en el CRM (así trabaja el negocio): que una factura esté «pagada» aquí y abierta en Alegra/Stripe, o
// que el CRM tenga más cobrado que el origen, es lo NORMAL y no se informa (eran 107 avisos de ruido). Solo se informa lo que sí pide
// una decisión: una factura anulada en el origen que en el CRM tiene cobros.
const ACTIONABLE_DISCREPANCIES = new Set(['anulada_en_origen_con_cobros_en_crm']);

async function alignExisting(row, incoming, actorId, label) {
  const { patch, paymentDelta, discrepancy: rawDiscrepancy } = mergeIncoming(row, incoming);
  const discrepancy = rawDiscrepancy && ACTIONABLE_DISCREPANCIES.has(rawDiscrepancy.kind) ? rawDiscrepancy : null;
  const extra = discrepancy ? { invoice_number: row.invoice_number, external_id: row.external_id, source: label, ...discrepancy } : null;
  if (Object.keys(patch).length === 0) return { updated: false, discrepancy: extra };
  const { error } = await supabase.from('invoices').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', row.id);
  if (error) return { updated: false, discrepancy: extra };
  if (paymentDelta > 0) {
    await supabase.from('invoice_payments').insert({
      invoice_id: row.id, amount: round2(paymentDelta), method: `Sincronizado de ${label}`,
      notes: 'Cobro detectado al sincronizar con el origen', paid_at: new Date().toISOString(), recorded_by: actorId || null,
    });
  }
  return { updated: true, discrepancy: extra };
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
  const accountName = canonicalAccountName(process.env.STRIPE_ACCOUNT_NAME || 'BitProximity LLC');

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

  let created = 0, updated = 0, skipped = 0;
  const discrepancies = [];
  const known = await knownExternalInvoices('stripe'); // una consulta, en vez de una por factura
  for (const inv of allInvoices) {
    if (inv.status === 'draft') continue;
    const existing = known.get(String(inv.id));
    if (existing) {
      const r = await alignExisting(existing, {
        status: stripeStatus(inv), paid_amount: Math.round(inv.amount_paid / 100 * 100) / 100, total: Math.round(inv.total / 100 * 100) / 100,
        subtotal: Math.round(inv.subtotal / 100 * 100) / 100, tax: Math.round((inv.total - inv.subtotal) / 100 * 100) / 100,
        due_date: inv.due_date ? dateInTz(new Date(inv.due_date * 1000)) : null,
      }, actorId, 'Stripe');
      if (r.updated) updated++; else skipped++;
      if (r.discrepancy) discrepancies.push(r.discrepancy);
      continue;
    }

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
      issue_date: dateInTz(new Date(inv.created * 1000)),
      due_date: inv.due_date ? dateInTz(new Date(inv.due_date * 1000)) : dateInTz(new Date(inv.created * 1000)),
      notes: `Importado de Stripe (${accountName}) - ${name} (${email})`,
      client_name: name === 'Sin nombre' ? null : name,
      source_account: accountName,
      external_source: 'stripe',
      external_id: inv.id,
      created_by: actorId,
    });
    if (!error) { created++; known.set(String(inv.id), { id: null }); }
  }

  if (actorId) await logAudit('invoice_sync', null, 'stripe_sync', actorId, { created, updated, skipped });
  if (created || updated) clearMemo();
  return { created, updated, skipped, discrepancies, total_en_stripe: allInvoices.length };
}

function alegraStatus(inv) {
  const paid = Number(inv.totalPaid || 0);
  const total = Number(inv.total || 0);
  if (inv.status === 'void') return 'cancelada';
  // «Cerrada» en Alegra es una factura saldada. Antes se guardaba como «cancelada» y salía como si se hubiera
  // anulado; ahora es «pagada» cuando el cobro lo confirma (y sigue «cancelada» si se cerró sin cobro, p. ej. con nota crédito).
  if (inv.status === 'closed') return total > 0 && paid >= total - 0.01 ? 'pagada' : 'cancelada';
  if (paid <= 0) return 'pendiente';
  if (paid < total) return 'parcial';
  return 'pagada';
}

function alegraAccountsFromEnv() {
  const accounts = [];
  if (process.env.ALEGRA_EMAIL && process.env.ALEGRA_TOKEN) {
    accounts.push({ index: 1, email: process.env.ALEGRA_EMAIL, token: process.env.ALEGRA_TOKEN, name: canonicalAccountName(process.env.ALEGRA_ACCOUNT_NAME || 'BitProximity LLC') });
  }
  if (process.env.ALEGRA_EMAIL_2 && process.env.ALEGRA_TOKEN_2) {
    accounts.push({ index: 2, email: process.env.ALEGRA_EMAIL_2, token: process.env.ALEGRA_TOKEN_2, name: canonicalAccountName(process.env.ALEGRA_ACCOUNT_NAME_2 || 'Cuenta 2') });
  }
  return accounts;
}

async function syncAlegra(actorId) {
  const accounts = alegraAccountsFromEnv();
  if (accounts.length === 0) return { error: 'Falta ALEGRA_EMAIL / ALEGRA_TOKEN en las variables de entorno de Railway.' };

  let totalCreated = 0, totalUpdated = 0, totalSkipped = 0, totalSeen = 0;
  const perAccount = [];
  const allDiscrepancies = [];

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
    let created = 0, updated = 0, skipped = 0;
    const known = await knownExternalInvoices(sourceKey); // una consulta por cuenta, en vez de una por factura
    for (const inv of all) {
      const existing = known.get(String(inv.id));
      if (existing) {
        const r = await alignExisting(existing, {
          status: alegraStatus(inv), paid_amount: Number(inv.totalPaid || 0), total: Number(inv.total || 0),
          subtotal: Number(inv.subtotal || 0), tax: Number(inv.tax || 0), due_date: inv.dueDate || inv.date,
        }, actorId, `Alegra (${account.name})`);
        if (r.updated) updated++; else skipped++;
        if (r.discrepancy) allDiscrepancies.push(r.discrepancy);
        continue;
      }

      const invoiceNumber = inv.numberTemplate?.fullNumber || inv.numberTemplate?.formattedNumber || String(inv.id);
      const origin = alegraOriginFor(invoiceNumber, account.name); // "B2…" → Mario Colombia
      const { error } = await insertInvoiceTolerant({
        invoice_number: invoiceNumber,
        currency: String(inv.currency?.code || 'COP').toUpperCase(),
        subtotal: Number(inv.subtotal || 0),
        tax: Number(inv.tax || 0),
        total: Number(inv.total || 0),
        paid_amount: Number(inv.totalPaid || 0),
        status: alegraStatus(inv),
        issue_date: inv.date,
        due_date: inv.dueDate || inv.date,
        notes: `Importado de Alegra (${origin}) - ${inv.client?.name || 'Sin nombre'}`,
        client_name: inv.client?.name || null,
        source_account: origin,
        external_source: sourceKey,
        external_id: String(inv.id),
        created_by: actorId,
      });
      if (!error) { created++; known.set(String(inv.id), { id: null }); }
    }

    perAccount.push({ account: account.name, created, updated, skipped, total_en_alegra: all.length });
    totalCreated += created;
    totalUpdated += updated;
    totalSkipped += skipped;
    totalSeen += all.length;
  }

  if (actorId) await logAudit('invoice_sync', null, 'alegra_sync', actorId, { created: totalCreated, updated: totalUpdated, skipped: totalSkipped, per_account: perAccount });
  if (totalCreated || totalUpdated) clearMemo();
  return { created: totalCreated, updated: totalUpdated, skipped: totalSkipped, discrepancies: allDiscrepancies, total_en_alegra: totalSeen, per_account: perAccount };
}

router.post('/stripe', requireRole('admin'), async (req, res) => {
  const result = await syncStripe(req.teamMember.id);
  syncStatus.record('Stripe', result);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

router.post('/alegra', requireRole('admin'), async (req, res) => {
  const result = await syncAlegra(req.teamMember.id);
  syncStatus.record('Alegra', result);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// GET /api/invoice-sync/status — cuándo corrió cada sincronización y qué diferencias quedaron con el origen.
router.get('/status', (req, res) => res.json(syncStatus.get()));

module.exports = router;
module.exports.syncStripe = syncStripe;
module.exports.syncAlegra = syncAlegra;
module.exports._test = { alegraStatus, stripeStatus, alignExisting };
