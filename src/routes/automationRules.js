const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rolePermissions');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

// GET /api/automation-rules
router.get('/', requirePermission('automations', 'view'), async (req, res) => {
  const { data, error } = await supabase.from('automation_rules').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/automation-rules
router.post('/', requirePermission('automations', 'manage'), async (req, res) => {
  const { name, trigger_type, trigger_config, action_type, action_config } = req.body;
  if (!name || !trigger_type || !action_type) return res.status(400).json({ error: 'Faltan name, trigger_type o action_type' });

  const { data, error } = await supabase
    .from('automation_rules')
    .insert({ name, trigger_type, trigger_config: trigger_config || {}, action_type, action_config: action_config || {}, created_by: req.teamMember.id })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });

  await logAudit('automation_rule', data.id, 'created', req.teamMember.id);
  res.status(201).json(data);
});

// PATCH /api/automation-rules/:id
router.patch('/:id', requirePermission('automations', 'manage'), async (req, res) => {
  const { data, error } = await supabase.from('automation_rules').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  await logAudit('automation_rule', req.params.id, 'updated', req.teamMember.id, { fields: Object.keys(req.body) });
  res.json(data);
});

// DELETE /api/automation-rules/:id
router.delete('/:id', requirePermission('automations', 'manage'), async (req, res) => {
  const { error } = await supabase.from('automation_rules').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  await logAudit('automation_rule', req.params.id, 'deleted', req.teamMember.id);
  res.status(204).send();
});

module.exports = router;
