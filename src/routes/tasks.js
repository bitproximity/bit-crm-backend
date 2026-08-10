const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { sendEmail } = require('../utils/email');
const { syncTaskToCalendar, deleteTaskFromCalendar } = require('../utils/googleCalendarSync');

const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || 'https://crm.bitproximity.com';

const router = express.Router();
router.use(requireAuth);

// GET /api/tasks?assignee_id=&status=&project_id=&due_before=
// Sin project_id devuelve "mis tareas" tipo bandeja personal (como Asana "My Tasks")
router.get('/', async (req, res) => {
  const { assignee_id, status, project_id, due_before } = req.query;

  let query = supabase
    .from('tasks')
    .select('*, projects(name), team_members!tasks_assignee_id_fkey(full_name), contacts(first_name,last_name)')
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
    supabase.from('tasks').select('*, team_members!tasks_assignee_id_fkey(full_name)').eq('id', id).single(),
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

  syncTaskToCalendar(data); // no bloquea la respuesta
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

  // Si cambió fecha, responsable, estado o título, refleja el cambio en Google Calendar
  const relevantFields = ['due_date', 'assignee_id', 'status', 'title', 'priority'];
  if (relevantFields.some((f) => f in req.body)) syncTaskToCalendar(data);
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const { data: task } = await supabase.from('tasks').select('assignee_id, google_event_id').eq('id', id).single();

  const { error } = await supabase.from('tasks').delete().eq('id', id);
  if (error) return res.status(400).json({ error: error.message });

  await logAudit('task', id, 'deleted', req.teamMember.id);
  res.status(204).send();

  if (task) deleteTaskFromCalendar(task);
});

// POST /api/tasks/:id/sync-calendar — sincroniza manualmente y devuelve el resultado real
// (útil para diagnosticar por qué una tarea no aparece en Google Calendar)
router.post('/:id/sync-calendar', async (req, res) => {
  const { data: task, error } = await supabase
    .from('tasks')
    .select('*, team_members!tasks_assignee_id_fkey(full_name)')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ error: 'Tarea no encontrada' });

  const result = await syncTaskToCalendar(task);
  res.json(result);
});

// POST /api/tasks/:id/comments
router.post('/:id/comments', async (req, res) => {
  const { id } = req.params;
  const { body } = req.body;

  const [{ data: comment, error }, { data: task }, { data: team }] = await Promise.all([
    supabase.from('task_comments').insert({ task_id: id, author_id: req.teamMember.id, body }).select().single(),
    supabase.from('tasks').select('title').eq('id', id).single(),
    supabase.from('team_members').select('id, full_name, email').eq('active', true),
  ]);

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(comment);

  // Notificación por correo a quien fue mencionado con @Nombre — no bloquea la respuesta.
  const mentioned = (team || []).filter(
    (m) => m.id !== req.teamMember.id && body.toLowerCase().includes(`@${m.full_name.toLowerCase()}`)
  );
  for (const member of mentioned) {
    const taskUrl = `${PUBLIC_APP_URL}/tasks?open=${id}`;
    sendEmail({
      to: member.email,
      subject: `${req.teamMember.full_name} te mencionó en "${task?.title || 'una tarea'}"`,
      html: `
        <div style="font-family: sans-serif; color: #1a1a2e; max-width: 480px;">
          <p><strong>${req.teamMember.full_name}</strong> te mencionó en un comentario de la tarea <strong>"${task?.title || ''}"</strong>:</p>
          <div style="background:#f4f4f8; border-radius:8px; padding:12px 16px; margin: 12px 0;">${body}</div>
          <a href="${taskUrl}" style="color:#8500FF;">Ver la tarea en Bit CRM →</a>
        </div>
      `,
    }).catch(() => {});
  }
});

module.exports = router;
