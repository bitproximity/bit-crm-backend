const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('tags').select('*').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/', async (req, res) => {
  const { data, error } = await supabase.from('tags').insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// POST /api/tags/:tagId/attach  { entity_type, entity_id }
router.post('/:tagId/attach', async (req, res) => {
  const { tagId } = req.params;
  const { entity_type, entity_id } = req.body;

  const { error } = await supabase
    .from('taggables')
    .insert({ tag_id: tagId, entity_type, entity_id });

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ ok: true });
});

// DELETE /api/tags/:tagId/detach  { entity_type, entity_id }
router.delete('/:tagId/detach', async (req, res) => {
  const { tagId } = req.params;
  const { entity_type, entity_id } = req.body;

  const { error } = await supabase
    .from('taggables')
    .delete()
    .match({ tag_id: tagId, entity_type, entity_id });

  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
});

// GET /api/tags/for/:entity_type/:entity_id — tags de una entidad puntual
router.get('/for/:entity_type/:entity_id', async (req, res) => {
  const { entity_type, entity_id } = req.params;
  const { data, error } = await supabase
    .from('taggables')
    .select('tags(*)')
    .eq('entity_type', entity_type)
    .eq('entity_id', entity_id);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map((row) => row.tags));
});

module.exports = router;
