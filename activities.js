const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/activities/for/:entity_type/:entity_id
router.get('/for/:entity_type/:entity_id', async (req, res) => {
  const { entity_type, entity_id } = req.params;
  const { data, error } = await supabase
    .from('activities')
    .select('*, team_members(full_name)')
    .eq('entity_type', entity_type)
    .eq('entity_id', entity_id)
    .order('occurred_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/activities  { entity_type, entity_id, type, summary, occurred_at? }
router.post('/', async (req, res) => {
  const payload = { ...req.body, author_id: req.teamMember.id };
  const { data, error } = await supabase.from('activities').insert(payload).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

module.exports = router;
