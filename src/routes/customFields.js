const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/custom-fields?entity_type=deal — definiciones disponibles
router.get('/', async (req, res) => {
  const { entity_type } = req.query;
  let query = supabase.from('custom_field_definitions').select('*').order('position');
  if (entity_type) query = query.eq('entity_type', entity_type);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/custom-fields — crear definición nueva (solo admin)
router.post('/', requireRole('admin'), async (req, res) => {
  const { data, error } = await supabase
    .from('custom_field_definitions')
    .insert(req.body)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { error } = await supabase.from('custom_field_definitions').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
});

// GET /api/custom-fields/values/:entity_id — valores actuales de una entidad
router.get('/values/:entity_id', async (req, res) => {
  const { entity_id } = req.params;
  const { data, error } = await supabase
    .from('custom_field_values')
    .select('*, custom_field_definitions(key,label,field_type)')
    .eq('entity_id', entity_id);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PUT /api/custom-fields/values/:entity_id  { field_id, value }
router.put('/values/:entity_id', async (req, res) => {
  const { entity_id } = req.params;
  const { field_id, value } = req.body;

  const { data, error } = await supabase
    .from('custom_field_values')
    .upsert({ field_id, entity_id, value, updated_at: new Date().toISOString() }, { onConflict: 'field_id,entity_id' })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

module.exports = router;
