const express = require('express');
const supabase = require('../config/supabase');
const { fetchAll } = require('../utils/fetchAll');
const { memo } = require('../utils/memo');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requirePage } = require('../middleware/pagePermissions');
const { todayInTz, dateInTz } = require('../utils/businessDate');
const { computeFinance } = require('../utils/financeMetrics');
const { buildReconciliation, applyAutoLinks, loadData } = require('../utils/invoiceLinker');

const router = express.Router();
router.use(requireAuth);
// Son cifras de facturación y cobranza: las ve quien puede ver Facturación (admin, salvo que se la bloqueen).
router.use(requirePage('facturacion'));

// GET /api/finance — métricas del CEO, todo en USD (ventas, facturado, cobranza, líderes, velocidad, conciliación).
router.get('/', async (req, res) => {
  try {
    const body = await memo('finance', 20000, async () => {
      const today = todayInTz();
      const oneYearAgo = dateInTz(new Date(Date.now() - 400 * 86400000));
      const [inv, pay, dls, rates, data] = await Promise.all([
        fetchAll(supabase.from('invoices').select('id, invoice_number, client_name, company_id, deal_id, total, paid_amount, currency, status, issue_date, due_date, source_account, companies(name)')),
        fetchAll(supabase.from('invoice_payments').select('invoice_id, amount, paid_at').gte('paid_at', `${oneYearAgo}T00:00:00Z`)),
        fetchAll(supabase.from('deals').select('id, title, value, currency, status, company_id, created_at, closed_at, product_line, pipelines(name), companies(country)').eq('status', 'ganado')),
        supabase.from('exchange_rates').select('*'),
        loadData(),
      ]);
      const failed = [inv, pay, dls].find((r) => r.error);
      if (failed) throw new Error(failed.error.message);
      const reconciliation = buildReconciliation({ ...data, year: today.slice(0, 4) });
      return computeFinance({ invoices: inv.data || [], payments: pay.data || [], deals: dls.data || [], rates: rates.data || [], today, reconciliation });
    });
    res.json(body);
  } catch (err) {
    res.status(500).json({ error: `No se pudieron calcular las métricas financieras: ${err.message}` });
  }
});

// GET /api/finance/reconciliation?year= — facturas sin trato (con sugerencia) y tratos ganados sin facturar.
router.get('/reconciliation', async (req, res) => {
  try {
    const year = /^\d{4}$/.test(String(req.query.year || '')) ? req.query.year : todayInTz().slice(0, 4);
    const data = await loadData();
    res.json(buildReconciliation({ ...data, year }));
  } catch (err) {
    res.status(500).json({ error: `No se pudo calcular la conciliación: ${err.message}` });
  }
});

// POST /api/finance/auto-link  { dry_run? } — vincula las facturas cuyo trato es casi seguro (confianza alta).
router.post('/auto-link', requireRole('admin'), async (req, res) => {
  try {
    res.json(await applyAutoLinks({ dryRun: !!req.body?.dry_run, actorId: req.teamMember.id }));
  } catch (err) {
    res.status(500).json({ error: `No se pudieron vincular las facturas: ${err.message}` });
  }
});

module.exports = router;
