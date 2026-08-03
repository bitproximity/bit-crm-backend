const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

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
  const progress = [];
  for (const p of activeProjects) {
    const { data: tasks } = await supabase.from('tasks').select('status').eq('project_id', p.id);
    const total = tasks?.length || 0;
    const done = tasks?.filter((t) => t.status === 'completada').length || 0;
    progress.push({
      project_id: p.id,
      name: p.name,
      total_tasks: total,
      completed_tasks: done,
      progress_pct: total ? Math.round((done / total) * 100) : 0,
    });
  }

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

module.exports = router;
