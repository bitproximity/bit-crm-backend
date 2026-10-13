const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const { memo } = require('../utils/memo');

const router = express.Router();
router.use(requireAuth);

// GET /api/settings/:key
router.get('/:key', async (req, res) => {
  try {
    const data = await memo(`setting:${req.params.key}`, 60000, async () => {
      const { data, error } = await supabase.from('crm_settings').select('value').eq('key', req.params.key).maybeSingle();
      if (error) throw error;
      return data; // null si no existe (también se recuerda: es un dato válido)
    });
    if (!data) return res.status(404).json({ error: `No existe la configuración "${req.params.key}".` });
    res.json(data.value);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/settings/:key  { ...valor nuevo... }
router.patch('/:key', requireRole('admin'), async (req, res) => {
  const { data, error } = await supabase
    .from('crm_settings')
    .upsert({ key: req.params.key, value: req.body, updated_at: new Date().toISOString() })
    .select('value')
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data.value);
});

module.exports = router;
