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

module.exports = router;
