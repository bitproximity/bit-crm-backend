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

  const { data: meetings, error } = await supabase
    .from('activities')
    .select('occurred_at, author_id, team_members(full_name)')
    .eq('type', 'reunion')
    .gte('occurred_at', since.toISOString())
    .order('occurred_at');

  if (error) return res.status(500).json({ error: error.message });

  const byWeek = {};
  const byOwner = {};

  meetings.forEach((m) => {
    const d = new Date(m.occurred_at);
    // Semana ISO simplificada: lunes de esa semana como clave
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const weekKey = monday.toISOString().slice(0, 10);

    byWeek[weekKey] = (byWeek[weekKey] || 0) + 1;

    const owner = m.team_members?.full_name || 'Sin asignar';
    byOwner[owner] = (byOwner[owner] || 0) + 1;
  });

  res.json({
    total: meetings.length,
    by_week: Object.entries(byWeek).map(([week, count]) => ({ week, count })).sort((a, b) => a.week.localeCompare(b.week)),
    by_owner: Object.entries(byOwner).map(([owner, count]) => ({ owner, count })).sort((a, b) => b.count - a.count),
  });
});

module.exports = router;
