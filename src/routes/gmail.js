const express = require('express');
const supabase = require('../config/supabase');
const { google } = require('googleapis');
const { getOAuthClient, GMAIL_SCOPES } = require('../config/googleOAuth');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/gmail/connect — devuelve la URL de consentimiento de Google
router.get('/connect', requireAuth, (req, res) => {
  const client = getOAuthClient();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // fuerza refresh_token incluso si ya autorizó antes
    scope: GMAIL_SCOPES,
    state: req.teamMember.id, // para saber a qué usuario asociar en el callback
  });
  res.json({ url });
});

// GET /api/gmail/callback — Google redirige aquí después del consentimiento
// (esta ruta NO lleva requireAuth: Google no manda el JWT del CRM, usamos `state`)
router.get('/callback', async (req, res) => {
  const { code, state: teamMemberId } = req.query;
  if (!code || !teamMemberId) return res.status(400).send('Falta code o state');

  try {
    const client = getOAuthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    const oauth2 = google.oauth2({ auth: client, version: 'v2' });
    const { data: userInfo } = await oauth2.userinfo.get();

    await supabase.from('gmail_connections').upsert(
      {
        team_member_id: teamMemberId,
        email: userInfo.email,
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token,
        token_expires_at: new Date(tokens.expiry_date).toISOString(),
      },
      { onConflict: 'team_member_id' }
    );

    res.redirect(`${process.env.FRONTEND_ORIGIN}/settings?gmail=connected`);
  } catch (err) {
    console.error('Error en Gmail OAuth callback:', err);
    res.redirect(`${process.env.FRONTEND_ORIGIN}/settings?gmail=error`);
  }
});

router.use(requireAuth);

// GET /api/gmail/status
router.get('/status', async (req, res) => {
  const { data } = await supabase
    .from('gmail_connections')
    .select('email, connected_at')
    .eq('team_member_id', req.teamMember.id)
    .maybeSingle();

  res.json({ connected: !!data, email: data?.email || null });
});

// DELETE /api/gmail/disconnect
router.delete('/disconnect', async (req, res) => {
  await supabase.from('gmail_connections').delete().eq('team_member_id', req.teamMember.id);
  res.status(204).send();
});

/**
 * Trae un cliente Gmail autenticado para el usuario actual, refrescando el
 * access_token si hace falta.
 */
async function getGmailClientForUser(teamMemberId) {
  const { data: conn } = await supabase
    .from('gmail_connections')
    .select('*')
    .eq('team_member_id', teamMemberId)
    .single();

  if (!conn) return null;

  const client = getOAuthClient();
  client.setCredentials({ refresh_token: conn.refresh_token });
  return google.gmail({ version: 'v1', auth: client });
}

// POST /api/gmail/sync/:entity_type/:entity_id  { email } — busca correos con ese contacto y los guarda
router.post('/sync/:entity_type/:entity_id', async (req, res) => {
  const { entity_type, entity_id } = req.params;
  const { email } = req.body;

  if (!email) return res.status(400).json({ error: 'Falta el email del contacto' });

  const gmail = await getGmailClientForUser(req.teamMember.id);
  if (!gmail) return res.status(400).json({ error: 'No has conectado tu Gmail todavía' });

  try {
    const { data: list } = await gmail.users.messages.list({
      userId: 'me',
      q: `from:${email} OR to:${email}`,
      maxResults: 20,
    });

    const messages = list.messages || [];
    const saved = [];

    for (const m of messages) {
      const { data: full } = await gmail.users.messages.get({
        userId: 'me',
        id: m.id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      });

      const headers = Object.fromEntries(
        (full.payload.headers || []).map((h) => [h.name.toLowerCase(), h.value])
      );

      const { data: row } = await supabase
        .from('gmail_messages')
        .upsert(
          {
            gmail_message_id: m.id,
            team_member_id: req.teamMember.id,
            entity_type,
            entity_id,
            from_email: headers.from,
            to_emails: headers.to ? headers.to.split(',').map((s) => s.trim()) : [],
            subject: headers.subject,
            snippet: full.snippet,
            sent_at: headers.date ? new Date(headers.date).toISOString() : null,
          },
          { onConflict: 'gmail_message_id' }
        )
        .select()
        .single();

      saved.push(row);
    }

    res.json(saved);
  } catch (err) {
    console.error('Error sincronizando Gmail:', err);
    res.status(500).json({ error: 'Error consultando Gmail' });
  }
});

// GET /api/gmail/messages/:entity_type/:entity_id — correos ya sincronizados y guardados
router.get('/messages/:entity_type/:entity_id', async (req, res) => {
  const { entity_type, entity_id } = req.params;
  const { data, error } = await supabase
    .from('gmail_messages')
    .select('*')
    .eq('entity_type', entity_type)
    .eq('entity_id', entity_id)
    .order('sent_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/gmail/calendar/events?days=14 — próximos eventos del calendario conectado
router.get('/calendar/events', async (req, res) => {
  const days = Number(req.query.days) || 14;
  const gmail = await getGmailClientForUser(req.teamMember.id); // reutiliza el mismo cliente OAuth

  const conn = await supabase
    .from('gmail_connections')
    .select('*')
    .eq('team_member_id', req.teamMember.id)
    .single();

  if (!conn.data) return res.status(400).json({ error: 'No has conectado tu cuenta de Google todavía' });

  const client = getOAuthClient();
  client.setCredentials({ refresh_token: conn.data.refresh_token });
  const calendar = google.calendar({ version: 'v3', auth: client });

  try {
    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + days * 86400000).toISOString();

    const { data } = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });

    const events = (data.items || []).map((e) => ({
      id: e.id,
      title: e.summary,
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      attendees: (e.attendees || []).map((a) => a.email),
      location: e.location,
      meetLink: e.hangoutLink,
    }));

    res.json(events);
  } catch (err) {
    console.error('Error consultando Google Calendar:', err);
    res.status(500).json({ error: 'Error consultando el calendario' });
  }
});

module.exports = router;
