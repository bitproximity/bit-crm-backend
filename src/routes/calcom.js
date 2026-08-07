const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/calcom/status
router.get('/status', async (req, res) => {
  const { data } = await supabase
    .from('calcom_connections')
    .select('connected_at')
    .eq('team_member_id', req.teamMember.id)
    .maybeSingle();

  res.json({ connected: !!data });
});

// POST /api/calcom/connect  { api_key }
router.post('/connect', async (req, res) => {
  const { api_key } = req.body;
  if (!api_key) return res.status(400).json({ error: 'Falta la API key' });

  // Valida la key contra la API de Cal.com antes de guardarla.
  // Nota: la API v1 de Cal.com no tiene endpoint /me — usamos /event-types,
  // que siempre responde 200 para una key válida (aunque no tenga event types).
  try {
    const testRes = await fetch(`https://api.cal.com/v1/event-types?apiKey=${api_key}`);
    if (!testRes.ok) return res.status(400).json({ error: 'API key inválida' });
  } catch (err) {
    return res.status(500).json({ error: 'No se pudo validar la API key con Cal.com' });
  }

  await supabase
    .from('calcom_connections')
    .upsert({ team_member_id: req.teamMember.id, api_key }, { onConflict: 'team_member_id' });

  res.json({ ok: true });
});

router.delete('/disconnect', async (req, res) => {
  await supabase.from('calcom_connections').delete().eq('team_member_id', req.teamMember.id);
  res.status(204).send();
});

// GET /api/calcom/bookings — próximas reuniones agendadas vía Cal.com
router.get('/bookings', async (req, res) => {
  const { data: conn } = await supabase
    .from('calcom_connections')
    .select('api_key')
    .eq('team_member_id', req.teamMember.id)
    .single();

  if (!conn) return res.status(400).json({ error: 'No has conectado Cal.com todavía' });

  try {
    const calRes = await fetch(`https://api.cal.com/v1/bookings?apiKey=${conn.api_key}&status=upcoming`);
    const data = await calRes.json();

    const bookings = (data.bookings || []).map((b) => ({
      id: b.id,
      title: b.title,
      start: b.startTime,
      end: b.endTime,
      attendees: (b.attendees || []).map((a) => a.email),
      status: b.status,
    }));

    res.json(bookings);
  } catch (err) {
    console.error('Error consultando Cal.com:', err);
    res.status(500).json({ error: 'Error consultando Cal.com' });
  }
});

module.exports = router;
