const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

// GET /api/lead-forms
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('lead_forms')
    .select('*, pipelines(name), pipeline_stages(name), team_members!lead_forms_owner_id_fkey(full_name)')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/lead-forms  { name, pipeline_id, stage_id, owner_id?, field_ids? }
router.post('/', requireRole('admin'), async (req, res) => {
  const { name, pipeline_id, stage_id, owner_id, field_ids } = req.body;
  if (!name || !pipeline_id || !stage_id) return res.status(400).json({ error: 'Faltan name, pipeline_id o stage_id' });

  const { data, error } = await supabase
    .from('lead_forms')
    .insert({ name, pipeline_id, stage_id, owner_id: owner_id || null, field_ids: field_ids || [], created_by: req.teamMember.id })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });

  await logAudit('lead_form', data.id, 'created', req.teamMember.id);
  res.status(201).json(data);
});

// PATCH /api/lead-forms/:id  { name?, active?, owner_id?, pipeline_id?, stage_id? }
router.patch('/:id', requireRole('admin'), async (req, res) => {
  const { data, error } = await supabase.from('lead_forms').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  await logAudit('lead_form', req.params.id, 'updated', req.teamMember.id, { fields: Object.keys(req.body) });
  res.json(data);
});

// DELETE /api/lead-forms/:id
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { error } = await supabase.from('lead_forms').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  await logAudit('lead_form', req.params.id, 'deleted', req.teamMember.id);
  res.status(204).send();
});

module.exports = router;
