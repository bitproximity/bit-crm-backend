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

// PATCH /api/tags/:tagId  { name?, color? }
router.patch('/:tagId', async (req, res) => {
  const { data, error } = await supabase.from('tags').update(req.body).eq('id', req.params.tagId).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE /api/tags/:tagId — borra el tag y todos sus vínculos (deals y contactos etiquetados quedan intactos, solo pierden la etiqueta)
router.delete('/:tagId', async (req, res) => {
  await supabase.from('taggables').delete().eq('tag_id', req.params.tagId);
  const { error } = await supabase.from('tags').delete().eq('id', req.params.tagId);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
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
  // taggables.entity_id es polimórfico (puede apuntar a deals o contacts), así que Supabase/PostgREST
  // no tiene una relación declarada para hacer el embed automático — hay que resolverlo en dos pasos.
  const { data: links, error: linksError } = await supabase
    .from('taggables').select('entity_id').eq('tag_id', tagId).eq('entity_type', 'contact');
  if (linksError) return res.status(500).json({ error: linksError.message });
  if (links.length === 0) return res.json([]);

  const { data: contacts, error } = await supabase
    .from('contacts').select('*, companies(name)').in('id', links.map((l) => l.entity_id));
  if (error) return res.status(500).json({ error: error.message });
  res.json(contacts);
});

// GET /api/tags/with-contact-counts — todos los tags con cuántos contactos tiene cada uno (para la vista de Listas)
router.get('/with-contact-counts', async (req, res) => {
  const [{ data: allTags, error: tagsError }, { data: links, error: linksError }] = await Promise.all([
    supabase.from('tags').select('id, name, color').order('name'),
    supabase.from('taggables').select('tag_id').eq('entity_type', 'contact'),
  ]);
  if (tagsError) return res.status(500).json({ error: tagsError.message });
  if (linksError) return res.status(500).json({ error: linksError.message });

  const counts = {};
  links.forEach((row) => { counts[row.tag_id] = (counts[row.tag_id] || 0) + 1; });

  const result = allTags
    .map((t) => ({ ...t, contact_count: counts[t.id] || 0 }))
    .sort((a, b) => b.contact_count - a.contact_count);

  res.json(result);
});

module.exports = router;
