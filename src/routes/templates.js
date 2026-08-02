const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

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
    const rows = items.map((item, i) => ({ ...item, template_id: template.id, position: i }));
    await supabase.from('task_template_items').insert(rows);
  }

  res.status(201).json(template);
});

router.patch('/:id', requireRole('admin', 'operaciones'), async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('task_templates')
    .update(req.body)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('task_templates').delete().eq('id', id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
});

module.exports = router;
