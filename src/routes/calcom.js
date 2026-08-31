const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const CAL_API_VERSION = '2024-08-13';

function calHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'cal-api-version': CAL_API_VERSION,
    'Content-Type': 'application/json',
  };
}

// GET /api/calcom/status
router.get('/status', async (req, res) => {
  const { data, error } = await supabase
    .from('calcom_connections')
    .select('id')
    .eq('team_member_id', req.teamMember.id)
    .maybeSingle();

  // Mismo bug que en Gmail: "connected_at" nunca existió como columna real, así que
  // esta consulta fallaba en silencio y siempre reportaba "no conectado".
  if (error) return res.status(500).json({ error: error.message });

  res.json({ connected: !!data });
});

// POST /api/calcom/connect  { api_key }
router.post('/connect', async (req, res) => {
  const { api_key } = req.body;
  if (!api_key) return res.status(400).json({ error: 'Falta la API key' });

  // Valida la key contra la API v2 de Cal.com antes de guardarla.
  // Usamos /v2/bookings (el mismo endpoint que consultamos después) en vez de
  // /v2/event-types, que devolvía 404 en algunos tipos de cuenta.
  try {
    const testRes = await fetch('https://api.cal.com/v2/bookings', {
      headers: calHeaders(api_key),
    });
    if (!testRes.ok) {
      const body = await testRes.text();
      console.error('Cal.com validation failed:', testRes.status, body);
      return res.status(400).json({ error: `API key inválida o sin permisos (Cal.com respondió ${testRes.status})` });
    }
  } catch (err) {
    console.error('Error validando Cal.com:', err);
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
    const calRes = await fetch('https://api.cal.com/v2/bookings?status=upcoming', {
      headers: calHeaders(conn.api_key),
    });

    if (!calRes.ok) {
      const body = await calRes.text();
      console.error('Error consultando Cal.com bookings:', calRes.status, body);
      return res.status(502).json({ error: 'Cal.com devolvió un error consultando reservas' });
    }

    const data = await calRes.json();
    const rawBookings = data.data || data.bookings || [];

    const bookings = rawBookings.map((b) => ({
      id: b.id || b.uid,
      title: b.title,
      start: b.start || b.startTime,
      end: b.end || b.endTime,
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
