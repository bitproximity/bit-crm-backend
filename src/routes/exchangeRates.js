const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const { memo } = require('../utils/memo');

const router = express.Router();
router.use(requireAuth);

// Cambian muy pocas veces al día: se recuerdan 60 s (cualquier escritura vacía la caché).
router.get('/', async (req, res) => {
  try {
    const data = await memo('exchange_rates', 60000, async () => {
      const { data, error } = await supabase.from('exchange_rates').select('*').order('currency');
      if (error) throw error;
      return data;
    });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/exchange-rates  { currency, rate_to_usd }  — solo admin, crea o actualiza
router.post('/', requireRole('admin'), async (req, res) => {
  const { currency, rate_to_usd } = req.body;
  if (!currency || rate_to_usd === undefined) return res.status(400).json({ error: 'Falta currency o rate_to_usd' });

  const { data, error } = await supabase
    .from('exchange_rates')
    .upsert({ currency, rate_to_usd, updated_at: new Date().toISOString() }, { onConflict: 'currency' })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
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
