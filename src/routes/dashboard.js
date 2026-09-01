const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
// El Dashboard es la pantalla principal para TODO el equipo, no solo admins — solo muestra
// totales agregados (nada sensible por trato individual), así que no debería estar
// restringido. Antes tenía requirePage('__admin_only__'), que bloqueaba con 403 a
// cualquiera que no fuera admin, incluyendo roles 'operaciones' y 'outbound'.

// GET /api/dashboard — resumen para la vista principal
router.get('/', async (req, res) => {
  const [
    { count: openDeals },
    { count: wonThisMonth },
    { count: overdueTasks },
    { count: myOpenTasks },
    { data: valueRows },
    { data: rates },
    { data: pipelineValueRows },
    { data: wonRecentRows },
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
    supabase.from('deals').select('value, currency, pipelines(name)').eq('status', 'abierto'),
    supabase.from('deals').select('title, value, currency, closed_at, companies(name)').eq('status', 'ganado').order('closed_at', { ascending: false }).limit(5),
  ]);

  const rateMap = Object.fromEntries((rates || []).map((r) => [r.currency, Number(r.rate_to_usd)]));
  const toUsd = (value, currency) => Number(value || 0) * (rateMap[currency] ?? 1);
  const openPipelineValueUsd = (valueRows || []).reduce((sum, d) => sum + toUsd(d.value, d.currency), 0);

  const byPipeline = {};
  (pipelineValueRows || []).forEach((d) => {
    const name = d.pipelines?.name || 'Sin pipeline';
    if (!byPipeline[name]) byPipeline[name] = { count: 0, value_usd: 0 };
    byPipeline[name].count += 1;
    byPipeline[name].value_usd += toUsd(d.value, d.currency);
  });
  const pipelineBreakdown = Object.entries(byPipeline)
    .map(([name, v]) => ({ name, count: v.count, value_usd: Math.round(v.value_usd) }))
    .sort((a, b) => b.value_usd - a.value_usd)
    .slice(0, 6);

  const recentWins = (wonRecentRows || []).map((d) => ({
    title: d.title,
    company: d.companies?.name || null,
    value_usd: Math.round(toUsd(d.value, d.currency)),
    closed_at: d.closed_at,
  }));

  res.json({
    open_deals: openDeals || 0,
    won_this_month: wonThisMonth || 0,
    overdue_tasks: overdueTasks || 0,
    my_open_tasks: myOpenTasks || 0,
    open_pipeline_value_usd: Math.round(openPipelineValueUsd),
    pipeline_breakdown: pipelineBreakdown,
    recent_wins: recentWins,
  });
});

function firstDayOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

module.exports = router;
