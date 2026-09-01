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
    { count: lostThisMonth },
    { count: newDealsThisMonth },
    { count: overdueTasks },
    { count: teamPendingTasks },
    { count: myOpenTasks },
    { data: valueRows },
    { data: rates },
    { data: pipelineValueRows },
    { data: wonRecentRows },
    { data: pipelineSalesRows },
    { data: productSalesRows },
  ] = await Promise.all([
    supabase.from('deals').select('*', { count: 'exact', head: true }).eq('status', 'abierto'),
    supabase
      .from('deals')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'ganado')
      .gte('closed_at', firstDayOfMonth()),
    supabase
      .from('deals')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'perdido')
      .gte('closed_at', firstDayOfMonth()),
    supabase
      .from('deals')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', firstDayOfMonth()),
    supabase
      .from('tasks')
      .select('*', { count: 'exact', head: true })
      .lt('due_date', new Date().toISOString())
      .neq('status', 'completada'),
    // Tareas pendientes del equipo completo (sin filtrar por assignee) — mismo criterio
    // que usa la página Tareas para su contador de encabezado ("X tareas pendientes").
    supabase.from('tasks').select('*', { count: 'exact', head: true }).neq('status', 'completada'),
    supabase
      .from('tasks')
      .select('*', { count: 'exact', head: true })
      .eq('assignee_id', req.teamMember.id)
      .neq('status', 'completada'),
    supabase.from('deals').select('value, currency').eq('status', 'abierto'),
    supabase.from('exchange_rates').select('*'),
    supabase.from('deals').select('value, currency, pipelines(name)').eq('status', 'abierto'),
    supabase.from('deals').select('title, value, currency, closed_at, companies(name)').eq('status', 'ganado').order('closed_at', { ascending: false }).limit(5),
    // Ventas (tratos ganados, todo el historial) agrupadas por embudo — para saber cuál
    // pipeline vende más, a diferencia de pipeline_breakdown que es sobre lo abierto.
    supabase.from('deals').select('value, currency, pipelines(name)').eq('status', 'ganado'),
    // Ranking de productos por ingresos reales — mismo cálculo que /api/metrics/products,
    // pero embebido aquí (esa ruta es __admin_only__ y el Dashboard es para todo el equipo).
    supabase
      .from('deal_line_items')
      .select('quantity, unit_price, currency, product_id, products(name), deals!inner(status)')
      .eq('deals.status', 'ganado'),
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

  // Pipeline con más ventas (ingresos de tratos ganados, todo el historial)
  const salesByPipeline = {};
  (pipelineSalesRows || []).forEach((d) => {
    const name = d.pipelines?.name || 'Sin pipeline';
    salesByPipeline[name] = (salesByPipeline[name] || 0) + toUsd(d.value, d.currency);
  });
  const topPipelineBySales = Object.entries(salesByPipeline)
    .map(([name, value_usd]) => ({ name, value_usd: Math.round(value_usd) }))
    .sort((a, b) => b.value_usd - a.value_usd)[0] || null;

  // Producto/servicio con más ventas (ingresos reales de línea de producto en tratos ganados)
  const salesByProduct = {};
  (productSalesRows || []).forEach((it) => {
    const key = it.product_id || `sin_producto:${it.products?.name || 'Producto sin nombre'}`;
    const name = it.products?.name || 'Producto sin nombre';
    const revenueUsd = toUsd(Number(it.quantity || 0) * Number(it.unit_price || 0), it.currency);
    if (!salesByProduct[key]) salesByProduct[key] = { name, revenue_usd: 0, quantity: 0 };
    salesByProduct[key].revenue_usd += revenueUsd;
    salesByProduct[key].quantity += Number(it.quantity || 0);
  });
  const topProductBySales = Object.values(salesByProduct)
    .map((p) => ({ name: p.name, revenue_usd: Math.round(p.revenue_usd), quantity: p.quantity }))
    .sort((a, b) => b.revenue_usd - a.revenue_usd)[0] || null;

  res.json({
    open_deals: openDeals || 0,
    won_this_month: wonThisMonth || 0,
    lost_this_month: lostThisMonth || 0,
    new_deals_this_month: newDealsThisMonth || 0,
    overdue_tasks: overdueTasks || 0,
    team_pending_tasks: teamPendingTasks || 0,
    my_open_tasks: myOpenTasks || 0,
    open_pipeline_value_usd: Math.round(openPipelineValueUsd),
    pipeline_breakdown: pipelineBreakdown,
    recent_wins: recentWins,
    top_pipeline_by_sales: topPipelineBySales,
    top_product_by_sales: topProductBySales,
  });
});

function firstDayOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

module.exports = router;
