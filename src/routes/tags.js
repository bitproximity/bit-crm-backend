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

// GET /api/tags/:tagId/contacts — todos los contactos con este tag (para ver una "lista" completa)
router.get('/:tagId/contacts', async (req, res) => {
  const { tagId } = req.params;
  const { data, error } = await supabase
    .from('taggables')
    .select('contacts(*, companies(name))')
    .eq('tag_id', tagId)
    .eq('entity_type', 'contact');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map((row) => row.contacts).filter(Boolean));
});

// GET /api/tags/with-contact-counts — todos los tags con cuántos contactos tiene cada uno (para la vista de Listas)
router.get('/with-contact-counts', async (req, res) => {
  const { data, error } = await supabase
    .from('taggables')
    .select('tag_id, tags(id, name, color)')
    .eq('entity_type', 'contact');

  if (error) return res.status(500).json({ error: error.message });

  const counts = {};
  data.forEach((row) => {
    if (!row.tags) return;
    if (!counts[row.tag_id]) counts[row.tag_id] = { ...row.tags, contact_count: 0 };
    counts[row.tag_id].contact_count += 1;
  });
  res.json(Object.values(counts).sort((a, b) => b.contact_count - a.contact_count));
});

module.exports = router;
