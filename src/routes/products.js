const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requirePage } = require('../middleware/pagePermissions');

const router = express.Router();
router.use(requireAuth);
router.use(requirePage('__admin_only__'));

router.get('/', async (req, res) => {
  const { type, active } = req.query;
  let query = supabase.from('products').select('*').order('name');
  if (type) query = query.eq('type', type);
  if (active !== undefined) query = query.eq('active', active === 'true');

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/', requireRole('admin', 'ventas'), async (req, res) => {
  const { data, error } = await supabase.from('products').insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

router.patch('/:id', requireRole('admin', 'ventas'), async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { error } = await supabase.from('products').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
});

module.exports = router;
