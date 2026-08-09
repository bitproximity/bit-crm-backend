const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { status, type, owner_id, is_b2b } = req.query;

  let query = supabase
    .from('projects')
    .select('*, companies(name), team_members(full_name)')
    .order('created_at', { ascending: false });

  if (status) query = query.eq('status', status);
  if (type) query = query.eq('type', type);
  if (owner_id) query = query.eq('owner_id', owner_id);
  if (is_b2b) query = query.eq('is_b2b', is_b2b === 'true');

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Trae el estado de TODAS las tareas de estos proyectos en una sola consulta
  // (antes hacía una consulta por proyecto -> muy lento con muchos proyectos).
  const projectIds = data.map((p) => p.id);
  const { data: allTasks } = projectIds.length
    ? await supabase.from('tasks').select('project_id, status').in('project_id', projectIds)
    : { data: [] };

  const statsByProject = {};
  (allTasks || []).forEach((t) => {
    const s = (statsByProject[t.project_id] ||= { total: 0, done: 0 });
    s.total += 1;
    if (t.status === 'completada') s.done += 1;
  });

  const withProgress = data.map((p) => {
    const s = statsByProject[p.id] || { total: 0, done: 0 };
    return { ...p, progress_pct: s.total ? Math.round((s.done / s.total) * 100) : 0, total_tasks: s.total };
  });

  res.json(withProgress);
});

// GET /api/projects/:id — incluye tareas anidadas (padres + subtareas)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [{ data: project, error }, { data: tasks, error: tasksError }] = await Promise.all([
      supabase.from('projects').select('*, companies(*)').eq('id', id).single(),
      supabase
        .from('tasks')
        .select('*, team_members!tasks_assignee_id_fkey(full_name)')
        .eq('project_id', id)
        .order('position', { nullsFirst: true }),
    ]);

    if (error) return res.status(404).json({ error: 'Proyecto no encontrado' });
    if (tasksError) return res.status(500).json({ error: tasksError.message });

    const byParent = {};
    (tasks || []).forEach((t) => {
      const key = t.parent_task_id || 'root';
      byParent[key] = byParent[key] || [];
      byParent[key].push(t);
    });
    const withSubtasks = (byParent['root'] || []).map((t) => ({
      ...t,
      subtasks: byParent[t.id] || [],
    }));

    res.json({ ...project, tasks: withSubtasks });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error inesperado cargando el proyecto' });
  }
});

router.post('/', async (req, res) => {
  const { data, error } = await supabase.from('projects').insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });

  await logAudit('project', data.id, 'created', req.teamMember.id);
  res.status(201).json(data);
});

router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('projects')
    .update(req.body)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  await logAudit('project', id, 'updated', req.teamMember.id, { fields: Object.keys(req.body) });
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('projects').delete().eq('id', id);
  if (error) return res.status(400).json({ error: error.message });

  await logAudit('project', id, 'deleted', req.teamMember.id);
  res.status(204).send();
});

module.exports = router;
