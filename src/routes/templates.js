const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const { applyTemplateToProject } = require('../utils/applyTemplate');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('task_templates')
    .select('*, task_template_items(*)')
    .order('name');

  if (error) return res.status(500).json({ error: error.message });
  data.forEach((t) => t.task_template_items.sort((a, b) => a.position - b.position));
  res.json(data);
});

router.post('/', requireRole('admin', 'operaciones'), async (req, res) => {
  const { name, description, items = [] } = req.body;

  const { data: template, error } = await supabase
    .from('task_templates')
    .insert({ name, description })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  if (items.length) {
    const rows = items
      .filter((it) => it && String(it.title || '').trim())
      .map((it, i) => ({
        template_id: template.id,
        title: String(it.title).trim(),
        description: it.description || null,
        days_offset: Number(it.days_offset) || 0,
        position: i,
      }));
    if (rows.length) {
      const ins = await supabase.from('task_template_items').insert(rows);
      if (ins.error) return res.status(400).json({ error: ins.error.message });
    }
  }

  res.status(201).json(template);
});

router.patch('/:id', requireRole('admin', 'operaciones'), async (req, res) => {
  const { id } = req.params;
  const { items, ...fields } = req.body || {};
  let data = null;
  if (Object.keys(fields).length) {
    const r = await supabase.from('task_templates').update(fields).eq('id', id).select().single();
    if (r.error) return res.status(400).json({ error: r.error.message });
    data = r.data;
  }
  // Si llegan los ítems, reemplazan a los anteriores (se edita la plantilla completa de una vez)
  if (Array.isArray(items)) {
    const del = await supabase.from('task_template_items').delete().eq('template_id', id);
    if (del.error) return res.status(400).json({ error: del.error.message });
    const rows = items
      .filter((it) => it && String(it.title || '').trim())
      .map((it, i) => ({
        template_id: id,
        title: String(it.title).trim(),
        description: it.description || null,
        days_offset: Number(it.days_offset) || 0,
        position: i,
      }));
    if (rows.length) {
      const ins = await supabase.from('task_template_items').insert(rows);
      if (ins.error) return res.status(400).json({ error: ins.error.message });
    }
  }
  const { data: full, error } = await supabase.from('task_templates').select('*, task_template_items(*)').eq('id', id).single();
  if (error) return res.status(400).json({ error: error.message });
  full.task_template_items.sort((a, b) => a.position - b.position);
  res.json(full || data);
});

// POST /api/templates/:id/apply  { project_id, base_date? } — carga las tareas de la plantilla en un proyecto existente
router.post('/:id/apply', requireRole('admin', 'operaciones'), async (req, res) => {
  const { project_id, base_date } = req.body || {};
  if (!project_id) return res.status(400).json({ error: 'Falta project_id.' });
  try {
    const { template, tasks } = await applyTemplateToProject({
      templateId: req.params.id,
      projectId: project_id,
      baseDate: base_date ? new Date(base_date) : new Date(),
      createdBy: req.teamMember.id,
    });
    await logAudit('project', project_id, 'updated', req.teamMember.id, { template: template.name, tasks_created: tasks.length });
    res.status(201).json({ created: tasks.length, tasks });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('task_templates').delete().eq('id', id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
});

module.exports = router;
