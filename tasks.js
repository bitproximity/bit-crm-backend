const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

// GET /api/tasks?assignee_id=&status=&project_id=&due_before=
// Sin project_id devuelve "mis tareas" tipo bandeja personal (como Asana "My Tasks")
router.get('/', async (req, res) => {
  const { assignee_id, status, project_id, due_before } = req.query;

  let query = supabase
    .from('tasks')
    .select('*, projects(name), team_members(full_name), contacts(first_name,last_name)')
    .order('due_date', { ascending: true, nullsFirst: false });

  if (assignee_id) query = query.eq('assignee_id', assignee_id);
  if (status) query = query.eq('status', status);
  if (project_id) query = query.eq('project_id', project_id);
  if (due_before) query = query.lte('due_date', due_before);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const [{ data: task, error }, { data: comments }, { data: subtasks }] = await Promise.all([
    supabase.from('tasks').select('*, team_members(full_name)').eq('id', id).single(),
    supabase
      .from('task_comments')
      .select('*, team_members(full_name)')
      .eq('task_id', id)
      .order('created_at'),
    supabase.from('tasks').select('*').eq('parent_task_id', id).order('position'),
  ]);

  if (error) return res.status(404).json({ error: 'Tarea no encontrada' });
  res.json({ ...task, comments, subtasks });
});

router.post('/', async (req, res) => {
  const payload = { ...req.body, created_by: req.teamMember.id };
  const { data, error } = await supabase.from('tasks').insert(payload).select().single();
  if (error) return res.status(400).json({ error: error.message });

  await logAudit('task', data.id, 'created', req.teamMember.id);
  res.status(201).json(data);
});

router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const updates = { ...req.body };

  if (updates.status === 'completada') updates.completed_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('tasks')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  const action = 'assignee_id' in req.body ? 'assigned' : 'status' in req.body ? 'status_changed' : 'updated';
  await logAudit('task', id, action, req.teamMember.id, { fields: Object.keys(req.body) });
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('tasks').delete().eq('id', id);
  if (error) return res.status(400).json({ error: error.message });

  await logAudit('task', id, 'deleted', req.teamMember.id);
  res.status(204).send();
});

// POST /api/tasks/:id/comments
router.post('/:id/comments', async (req, res) => {
  const { id } = req.params;
  const { body } = req.body;

  const { data, error } = await supabase
    .from('task_comments')
    .insert({ task_id: id, author_id: req.teamMember.id, body })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

module.exports = router;
