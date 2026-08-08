const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/spaces — lista espacios con conteo de proyectos
router.get('/', async (req, res) => {
  const [{ data: spaces, error }, { data: projects }] = await Promise.all([
    supabase.from('spaces').select('*').order('position'),
    supabase.from('projects').select('id, space_id'),
  ]);

  if (error) return res.status(500).json({ error: error.message });

  const counts = {};
  (projects || []).forEach((p) => {
    if (!p.space_id) return;
    counts[p.space_id] = (counts[p.space_id] || 0) + 1;
  });

  res.json(spaces.map((s) => ({ ...s, project_count: counts[s.id] || 0 })));
});

// GET /api/spaces/:id — espacio + sus proyectos (con % de avance)
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const [{ data: space, error }, { data: projects }] = await Promise.all([
    supabase.from('spaces').select('*').eq('id', id).single(),
    supabase.from('projects').select('*, companies(name)').eq('space_id', id).order('created_at', { ascending: false }),
  ]);

  if (error) return res.status(404).json({ error: 'Espacio no encontrado' });

  const projectIds = (projects || []).map((p) => p.id);
  const { data: allTasks } = projectIds.length
    ? await supabase.from('tasks').select('project_id, status').in('project_id', projectIds)
    : { data: [] };

  const statsByProject = {};
  (allTasks || []).forEach((t) => {
    const s = (statsByProject[t.project_id] ||= { total: 0, done: 0 });
    s.total += 1;
    if (t.status === 'completada') s.done += 1;
  });

  const withProgress = (projects || []).map((p) => {
    const s = statsByProject[p.id] || { total: 0, done: 0 };
    return { ...p, progress_pct: s.total ? Math.round((s.done / s.total) * 100) : 0, total_tasks: s.total };
  });

  res.json({ ...space, projects: withProgress });
});

router.post('/', async (req, res) => {
  const { data, error } = await supabase.from('spaces').insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

router.patch('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('spaces')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  const { error } = await supabase.from('spaces').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
});

module.exports = router;
