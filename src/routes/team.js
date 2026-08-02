const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('team_members')
    .select('id, full_name, email, role, active')
    .order('full_name');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Solo admin invita/crea miembros nuevos (el alta de auth se hace en Supabase Auth aparte)
router.post('/', requireRole('admin'), async (req, res) => {
  const { data, error } = await supabase.from('team_members').insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

router.patch('/:id', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('team_members')
    .update(req.body)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// GET /api/team/me — perfil del usuario autenticado
router.get('/me', async (req, res) => {
  res.json(req.teamMember);
});

module.exports = router;
