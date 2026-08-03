const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { status, type, owner_id } = req.query;

  let query = supabase
    .from('projects')
    .select('*, companies(name), team_members(full_name)')
    .order('created_at', { ascending: false });

  if (status) query = query.eq('status', status);
  if (type) query = query.eq('type', type);
  if (owner_id) query = query.eq('owner_id', owner_id);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Agrega % de avance (tareas completadas / total) a cada proyecto
  const withProgress = await Promise.all(
    data.map(async (p) => {
      const { data: tasks } = await supabase.from('tasks').select('status').eq('project_id', p.id);
      const total = tasks?.length || 0;
      const done = tasks?.filter((t) => t.status === 'completada').length || 0;
      return { ...p, progress_pct: total ? Math.round((done / total) * 100) : 0, total_tasks: total };
    })
  );

  res.json(withProgress);
});

// GET /api/projects/:id — incluye tareas anidadas (padres + subtareas)
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const [{ data: project, error }, { data: tasks }] = await Promise.all([
    supabase.from('projects').select('*, companies(*)').eq('id', id).single(),
    supabase
      .from('tasks')
      .select('*, team_members(full_name)')
      .eq('project_id', id)
      .order('position'),
  ]);

  if (error) return res.status(404).json({ error: 'Proyecto no encontrado' });

  const byParent = {};
  tasks.forEach((t) => {
    const key = t.parent_task_id || 'root';
    byParent[key] = byParent[key] || [];
    byParent[key].push(t);
  });
  const withSubtasks = (byParent['root'] || []).map((t) => ({
    ...t,
    subtasks: byParent[t.id] || [],
  }));

  res.json({ ...project, tasks: withSubtasks });
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
