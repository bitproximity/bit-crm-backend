const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/dashboard — resumen para la vista principal
router.get('/', async (req, res) => {
  const [
    { count: openDeals },
    { count: wonThisMonth },
    { count: overdueTasks },
    { count: myOpenTasks },
    { data: valueRows },
    { data: rates },
  ] = await Promise.all([
    supabase.from('deals').select('*', { count: 'exact', head: true }).eq('status', 'abierto'),
    supabase
      .from('deals')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'ganado')
      .gte('closed_at', firstDayOfMonth()),
    supabase
      .from('tasks')
      .select('*', { count: 'exact', head: true })
      .lt('due_date', new Date().toISOString())
      .neq('status', 'completada'),
    supabase
      .from('tasks')
      .select('*', { count: 'exact', head: true })
      .eq('assignee_id', req.teamMember.id)
      .neq('status', 'completada'),
    supabase.from('deals').select('value, currency').eq('status', 'abierto'),
    supabase.from('exchange_rates').select('*'),
  ]);

  const rateMap = Object.fromEntries((rates || []).map((r) => [r.currency, Number(r.rate_to_usd)]));
  const openPipelineValueUsd = (valueRows || []).reduce((sum, d) => {
    const rate = rateMap[d.currency] ?? 1;
    return sum + Number(d.value || 0) * rate;
  }, 0);

  res.json({
    open_deals: openDeals || 0,
    won_this_month: wonThisMonth || 0,
    overdue_tasks: overdueTasks || 0,
    my_open_tasks: myOpenTasks || 0,
    open_pipeline_value_usd: Math.round(openPipelineValueUsd),
  });
});

function firstDayOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

module.exports = router;
