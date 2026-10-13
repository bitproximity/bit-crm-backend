const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { memo } = require('../utils/memo');

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
  try {
    // Varias pestañas/pantallas lo piden a la vez: una sola consulta cada 5 s por persona.
    const count = await memo(`unread:${req.teamMember.id}`, 5000, async () => {
      const { count, error } = await supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_id', req.teamMember.id)
        .eq('read', false);
      if (error) throw error;
      return count || 0;
    });
    res.json({ count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
