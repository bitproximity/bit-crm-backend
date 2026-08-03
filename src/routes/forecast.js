const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/forecast?months=3 — forecast ponderado por probabilidad, agrupado por mes de cierre esperado
router.get('/', async (req, res) => {
  const months = Number(req.query.months) || 3;

  const [{ data: deals }, { data: rates }] = await Promise.all([
    supabase
      .from('deals')
      .select('value, currency, probability, expected_close_date, status, pipeline_id, pipelines(name)')
      .eq('status', 'abierto')
      .not('expected_close_date', 'is', null),
    supabase.from('exchange_rates').select('*'),
  ]);

  const rateMap = Object.fromEntries((rates || []).map((r) => [r.currency, Number(r.rate_to_usd)]));
  const toUsd = (value, currency) => Number(value || 0) * (rateMap[currency] ?? 1);

  const now = new Date();
  const buckets = {};
  for (let i = 0; i < months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    buckets[key] = { month: key, weighted_usd: 0, unweighted_usd: 0, deal_count: 0 };
  }

  (deals || []).forEach((d) => {
    const closeDate = new Date(d.expected_close_date);
    const key = `${closeDate.getFullYear()}-${String(closeDate.getMonth() + 1).padStart(2, '0')}`;
    if (!buckets[key]) return; // fuera del rango pedido
    const usdValue = toUsd(d.value, d.currency);
    buckets[key].weighted_usd += usdValue * (d.probability / 100);
    buckets[key].unweighted_usd += usdValue;
    buckets[key].deal_count += 1;
  });

  res.json({
    months: Object.values(buckets).map((b) => ({
      ...b,
      weighted_usd: Math.round(b.weighted_usd),
      unweighted_usd: Math.round(b.unweighted_usd),
    })),
  });
});

module.exports = router;
