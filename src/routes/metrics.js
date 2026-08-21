const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { requirePage } = require('../middleware/pagePermissions');

const router = express.Router();
router.use(requireAuth);
router.use(requirePage('__admin_only__'));

// GET /api/metrics — panorama completo para vistas de reporting
router.get('/', async (req, res) => {
  const [
    { data: dealsByStage },
    { data: tasksByStatus },
    { data: projects },
    { data: wonLost },
  ] = await Promise.all([
    supabase.from('deals').select('stage_id, value, currency, pipeline_stages(name)').eq('status', 'abierto'),
    supabase.from('tasks').select('status'),
    supabase.from('projects').select('id, name, status'),
    supabase.from('deals').select('status').in('status', ['ganado', 'perdido']),
  ]);

  // Deals por etapa
  const stageMap = {};
  (dealsByStage || []).forEach((d) => {
    const name = d.pipeline_stages?.name || 'Sin etapa';
    stageMap[name] = stageMap[name] || { stage: name, count: 0, value: 0 };
    stageMap[name].count += 1;
    stageMap[name].value += Number(d.value || 0);
  });

  // Tareas por estado
  const taskMap = {};
  (tasksByStatus || []).forEach((t) => {
    taskMap[t.status] = (taskMap[t.status] || 0) + 1;
  });

  // Avance de proyectos activos (% de tareas completadas)
  const activeProjects = (projects || []).filter((p) => p.status === 'activo');
  const activeProjectIds = activeProjects.map((p) => p.id);
  const { data: allProjectTasks } = activeProjectIds.length
    ? await supabase.from('tasks').select('project_id, status').in('project_id', activeProjectIds)
    : { data: [] };

  const tasksByProject = {};
  (allProjectTasks || []).forEach((t) => {
    const s = (tasksByProject[t.project_id] ||= { total: 0, done: 0 });
    s.total += 1;
    if (t.status === 'completada') s.done += 1;
  });

  const progress = activeProjects.map((p) => {
    const s = tasksByProject[p.id] || { total: 0, done: 0 };
    return {
      project_id: p.id,
      name: p.name,
      total_tasks: s.total,
      completed_tasks: s.done,
      progress_pct: s.total ? Math.round((s.done / s.total) * 100) : 0,
    };
  });

  // Win rate
  const won = (wonLost || []).filter((d) => d.status === 'ganado').length;
  const lost = (wonLost || []).filter((d) => d.status === 'perdido').length;
  const winRate = won + lost > 0 ? Math.round((won / (won + lost)) * 100) : null;

  res.json({
    deals_by_stage: Object.values(stageMap),
    tasks_by_status: taskMap,
    project_progress: progress,
    win_rate_pct: winRate,
    won_count: won,
    lost_count: lost,
  });
});

// GET /api/metrics/meetings?weeks=8 — reuniones agendadas por semana y por vendedor
router.get('/meetings', async (req, res) => {
  const weeks = Number(req.query.weeks) || 8;
  const since = new Date();
  since.setDate(since.getDate() - weeks * 7);

  // Lee de b2b_records (Bit Prospect) — es donde vive la data real de reuniones que se está
  // cargando por cliente. Antes leía de "activities" tipo reunión, una tabla que nunca se
  // llenó, por eso siempre daba 0.
  const { data: meetings, error } = await supabase
    .from('b2b_records')
    .select('meeting_date, executive, created_by, team_members(full_name)')
    .not('meeting_date', 'is', null)
    .gte('meeting_date', since.toISOString().slice(0, 10))
    .order('meeting_date');

  if (error) return res.status(500).json({ error: error.message });

  const byWeek = {};
  const byOwner = {};

  meetings.forEach((m) => {
    const d = new Date(`${m.meeting_date}T00:00:00`);
    // Semana ISO simplificada: lunes de esa semana como clave
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const weekKey = monday.toISOString().slice(0, 10);

    byWeek[weekKey] = (byWeek[weekKey] || 0) + 1;

    const owner = (m.executive && m.executive.trim()) || m.team_members?.full_name || 'Sin asignar';
    byOwner[owner] = (byOwner[owner] || 0) + 1;
  });

  res.json({
    total: meetings.length,
    by_week: Object.entries(byWeek).map(([week, count]) => ({ week, count })).sort((a, b) => a.week.localeCompare(b.week)),
    by_owner: Object.entries(byOwner).map(([owner, count]) => ({ owner, count })).sort((a, b) => b.count - a.count),
  });
});

// GET /api/metrics/products — ranking de productos por ingresos reales (tratos ganados),
// desglosado por país e industria de la empresa compradora.
router.get('/products', async (req, res) => {
  const [{ data: items, error }, { data: rates }] = await Promise.all([
    supabase
      .from('deal_line_items')
      .select('quantity, unit_price, currency, product_id, products(name), deals!inner(status, company_id, companies(country, industry))')
      .eq('deals.status', 'ganado'),
    supabase.from('exchange_rates').select('*'),
  ]);
  if (error) return res.status(500).json({ error: error.message });

  const rateMap = Object.fromEntries((rates || []).map((r) => [r.currency, Number(r.rate_to_usd)]));
  const toUsd = (value, currency) => Number(value || 0) * (rateMap[currency] ?? 1);

  const products = {};

  (items || []).forEach((it) => {
    const key = it.product_id || `sin_producto:${it.products?.name || 'Producto sin nombre'}`;
    const name = it.products?.name || 'Producto sin nombre';
    const revenueUsd = toUsd(Number(it.quantity || 0) * Number(it.unit_price || 0), it.currency);
    const country = it.deals?.companies?.country?.trim() || 'Sin especificar';
    const industry = it.deals?.companies?.industry?.trim() || 'Sin especificar';

    if (!products[key]) {
      products[key] = { product_id: it.product_id, name, revenue_usd: 0, quantity: 0, by_country: {}, by_industry: {} };
    }
    const p = products[key];
    p.revenue_usd += revenueUsd;
    p.quantity += Number(it.quantity || 0);

    p.by_country[country] = p.by_country[country] || { revenue_usd: 0, quantity: 0 };
    p.by_country[country].revenue_usd += revenueUsd;
    p.by_country[country].quantity += Number(it.quantity || 0);

    p.by_industry[industry] = p.by_industry[industry] || { revenue_usd: 0, quantity: 0 };
    p.by_industry[industry].revenue_usd += revenueUsd;
    p.by_industry[industry].quantity += Number(it.quantity || 0);
  });

  const toSortedList = (obj) =>
    Object.entries(obj).map(([name, v]) => ({ name, ...v, revenue_usd: Math.round(v.revenue_usd) })).sort((a, b) => b.revenue_usd - a.revenue_usd);

  const result = Object.values(products)
    .map((p) => ({
      product_id: p.product_id,
      name: p.name,
      revenue_usd: Math.round(p.revenue_usd),
      quantity: p.quantity,
      by_country: toSortedList(p.by_country),
      by_industry: toSortedList(p.by_industry),
    }))
    .sort((a, b) => b.revenue_usd - a.revenue_usd);

  res.json({ products: result, top: result[0] || null });
});

module.exports = router;
