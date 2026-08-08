const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/documents/tree — árbol completo (id, title, parent_id) para armar el sidebar sin pedir contenido
router.get('/tree', async (req, res) => {
  const { deal_id } = req.query;
  let query = supabase
    .from('documents')
    .select('id, title, parent_id, space_id, deal_id, position')
    .order('position');

  if (deal_id) query = query.eq('deal_id', deal_id);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/documents/:id — documento con su contenido completo
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('documents')
    .select('*, team_members(full_name)')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ error: 'Documento no encontrado' });
  res.json(data);
});

// POST /api/documents  { title?, content?, parent_id?, space_id? }
router.post('/', async (req, res) => {
  const payload = { ...req.body, created_by: req.teamMember.id };
  const { data, error } = await supabase.from('documents').insert(payload).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/documents/:id  { title?, content?, parent_id?, position? }
router.patch('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('documents')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE /api/documents/:id — borra el documento y sus hijos (cascade en la FK)
router.delete('/:id', async (req, res) => {
  const { error } = await supabase.from('documents').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
});

module.exports = router;
