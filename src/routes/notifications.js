const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/notifications?unread_only=true&limit=30
router.get('/', async (req, res) => {
  const { unread_only, limit = 30 } = req.query;
  let query = supabase
    .from('notifications')
    .select('*')
    .eq('recipient_id', req.teamMember.id)
    .order('created_at', { ascending: false })
    .limit(Number(limit));
  if (unread_only === 'true') query = query.eq('read', false);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/notifications/unread-count — payload chico para el globito, se puede pedir seguido
router.get('/unread-count', async (req, res) => {
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', req.teamMember.id)
    .eq('read', false);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ count: count || 0 });
});

// PATCH /api/notifications/:id  { read: true }
router.patch('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('notifications')
    .update({ read: req.body.read !== false })
    .eq('id', req.params.id)
    .eq('recipient_id', req.teamMember.id) // nadie marca leídas las notificaciones de otro
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// POST /api/notifications/mark-all-read
router.post('/mark-all-read', async (req, res) => {
  const { error } = await supabase
    .from('notifications')
    .update({ read: true })
    .eq('recipient_id', req.teamMember.id)
    .eq('read', false);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
