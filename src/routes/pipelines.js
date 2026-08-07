const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/pipelines — lista pipelines con sus stages ordenadas
router.get('/', async (req, res) => {
  const { data: pipelines, error } = await supabase
    .from('pipelines')
    .select('*, pipeline_stages(*)')
    .order('created_at');

  if (error) return res.status(500).json({ error: error.message });

  pipelines.forEach((p) => p.pipeline_stages.sort((a, b) => a.position - b.position));
  res.json(pipelines);
});

// POST /api/pipelines — crear pipeline nuevo (solo admin)
router.post('/', requireRole('admin'), async (req, res) => {
  const { data, error } = await supabase.from('pipelines').insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/pipelines/:id — renombrar pipeline
router.patch('/:id', requireRole('admin'), async (req, res) => {
  const { data, error } = await supabase
    .from('pipelines')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE /api/pipelines/:id — borra el pipeline (falla si tiene deals, por integridad referencial)
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { error } = await supabase.from('pipelines').delete().eq('id', req.params.id);
  if (error) {
    if (error.message.includes('foreign key') || error.code === '23503') {
      return res.status(400).json({ error: 'No se puede borrar: tiene deals asociados. Muévelos o bórralos primero.' });
    }
    return res.status(400).json({ error: error.message });
  }
  res.status(204).send();
});

// DELETE /api/pipelines/stages/:stageId — borra una etapa (falla si tiene deals, por integridad referencial)
router.delete('/stages/:stageId', requireRole('admin'), async (req, res) => {
  const { error } = await supabase.from('pipeline_stages').delete().eq('id', req.params.stageId);
  if (error) {
    if (error.message.includes('foreign key') || error.code === '23503') {
      return res.status(400).json({ error: 'No se puede borrar: hay deals en esta etapa. Muévelos primero.' });
    }
    return res.status(400).json({ error: error.message });
  }
  res.status(204).send();
});

// POST /api/pipelines/:id/stages — agregar etapa
router.post('/:id/stages', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('pipeline_stages')
    .insert({ ...req.body, pipeline_id: id })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/pipelines/stages/:stageId — editar/reordenar etapa
router.patch('/stages/:stageId', requireRole('admin'), async (req, res) => {
  const { stageId } = req.params;
  const { data, error } = await supabase
    .from('pipeline_stages')
    .update(req.body)
    .eq('id', stageId)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// GET /api/pipelines/suggest?country=&company_type=
router.get('/suggest', async (req, res) => {
  const { country, company_type } = req.query;

  let query = supabase.from('pipeline_rules').select('*, pipelines(*)');
  if (country) query = query.eq('country', country);
  if (company_type) query = query.eq('company_type', company_type);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Prioriza una regla que matchee país + tipo exacto, si no, cualquiera que matchee algo
  const exact = data.find((r) => r.country === country && r.company_type === company_type);
  res.json({ suggested: exact?.pipelines || data[0]?.pipelines || null });
});

// POST /api/pipelines/rules  { pipeline_id, country?, company_type? } — solo admin
router.post('/rules', requireRole('admin'), async (req, res) => {
  const { data, error } = await supabase.from('pipeline_rules').insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

router.get('/rules', async (req, res) => {
  const { data, error } = await supabase.from('pipeline_rules').select('*, pipelines(name)');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/rules/:id', requireRole('admin'), async (req, res) => {
  const { error } = await supabase.from('pipeline_rules').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
});

module.exports = router;
