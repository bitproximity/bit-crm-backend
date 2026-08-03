const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('exchange_rates').select('*').order('currency');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /api/exchange-rates/:currency  { rate_to_usd }  — solo admin, actualización manual
router.patch('/:currency', requireRole('admin'), async (req, res) => {
  const { currency } = req.params;
  const { rate_to_usd } = req.body;

  const { data, error } = await supabase
    .from('exchange_rates')
    .update({ rate_to_usd, updated_at: new Date().toISOString() })
    .eq('currency', currency)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

module.exports = router;
