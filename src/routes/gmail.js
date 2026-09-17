const express = require('express');
const supabase = require('../config/supabase');
const { google } = require('googleapis');
const { getOAuthClient, GMAIL_SCOPES } = require('../config/googleOAuth');
const { requireAuth } = require('../middleware/auth');

const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || 'https://crm.bitproximity.com';

const router = express.Router();

// GET /api/gmail/connect — devuelve la URL de consentimiento de Google
router.get('/connect', requireAuth, (req, res) => {
  const client = getOAuthClient();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    // select_account fuerza el selector de cuenta de Google en vez de reusar la sesión
    // activa del navegador — si no, "conectar otra cuenta" reconectaría siempre la misma.
    prompt: 'select_account consent',
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

    // onConflict por (team_member_id, email): conectar una cuenta NUEVA agrega una fila
    // aparte en vez de pisar la que ya tenías — así se pueden tener varias cuentas
    // conectadas a la vez (ej. mario@bitproximity.com + mario@bitwifiapp.com). Si
    // reconectás la MISMA cuenta (ej. para refrescar el token), sigue actualizando la
    // fila existente en vez de duplicarla.
    await supabase.from('gmail_connections').upsert(
      {
        team_member_id: teamMemberId,
        email: userInfo.email,
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token,
        token_expires_at: new Date(tokens.expiry_date).toISOString(),
      },
      { onConflict: 'team_member_id,email' }
    );

    res.redirect(`${PUBLIC_APP_URL}/profile?gmail=connected`);
  } catch (err) {
    console.error('Error en Gmail OAuth callback:', err);
    res.redirect(`${PUBLIC_APP_URL}/profile?gmail=error`);
  }
});

router.use(requireAuth);

// GET /api/gmail/status — ahora puede haber más de una cuenta conectada
router.get('/status', async (req, res) => {
  const { data, error } = await supabase
    .from('gmail_connections')
    .select('email')
    .eq('team_member_id', req.teamMember.id)
    .order('id', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  const connections = data || [];
  // Se mantienen "connected"/"email" (la primera cuenta conectada) por compatibilidad con
  // quien todavía lea la respuesta vieja, y se agrega "connections" con todas.
  res.json({ connected: connections.length > 0, email: connections[0]?.email || null, connections });
});

// DELETE /api/gmail/disconnect/:email — desconecta una cuenta puntual (antes solo había una)
router.delete('/disconnect/:email', async (req, res) => {
  await supabase.from('gmail_connections').delete().eq('team_member_id', req.teamMember.id).eq('email', decodeURIComponent(req.params.email));
  res.status(204).send();
});

/**
 * Trae UN cliente Gmail autenticado — la cuenta "principal" (la primera que se conectó).
 * Se usa solo donde de verdad hace falta una sola cuenta de referencia (por ahora, nada
 * más internamente; se deja por compatibilidad de firma con otras funciones del archivo).
 */
async function getGmailClientForUser(teamMemberId) {
  const clients = await getAllGmailClientsForUser(teamMemberId);
  return clients[0]?.gmail || null;
}

/**
 * Trae un cliente Gmail autenticado POR CADA cuenta conectada de esta persona — para que
 * buscar/sincronizar correos, o traer sus contactos de Google, mire en todas las cuentas
 * conectadas (ej. mario@bitproximity.com Y mario@bitwifiapp.com) y no solo en la primera.
 */
async function getAllGmailClientsForUser(teamMemberId) {
  const { data: conns } = await supabase
    .from('gmail_connections')
    .select('*')
    .eq('team_member_id', teamMemberId)
    .order('id', { ascending: true });

  return (conns || []).map((conn) => {
    const client = getOAuthClient();
    client.setCredentials({ refresh_token: conn.refresh_token });
    return { email: conn.email, gmail: google.gmail({ version: 'v1', auth: client }) };
  });
}

// Extrae el cuerpo (texto plano y HTML) del payload de un mensaje de Gmail — los mensajes
// vienen como un árbol de "parts" anidado (texto y HTML como hermanos, y a veces todo
// envuelto en un part "multipart/*" sin contenido propio), así que hay que recorrerlo.
function extractBody(payload) {
  let text = null;
  let html = null;

  function walk(part) {
    if (!part) return;
    const data = part.body?.data;
    if (data) {
      // Gmail codifica el cuerpo en base64url (usa "-"/"_" en vez de "+"/"/") — se
      // normaliza a base64 estándar a mano en vez de depender de que el Node del
      // servidor soporte el encoding 'base64url' nativo de Buffer.
      const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(normalized, 'base64').toString('utf8');
      if (part.mimeType === 'text/plain' && !text) text = decoded;
      if (part.mimeType === 'text/html' && !html) html = decoded;
    }
    (part.parts || []).forEach(walk);
  }

  walk(payload);
  return { text, html };
}

// POST /api/gmail/sync/:entity_type/:entity_id  { email } — busca correos con ese contacto y los guarda
router.post('/sync/:entity_type/:entity_id', async (req, res) => {
  const { entity_type, entity_id } = req.params;
  const { email } = req.body;

  if (!email) return res.status(400).json({ error: 'Falta el email del contacto' });

  const clients = await getAllGmailClientsForUser(req.teamMember.id);
  if (clients.length === 0) return res.status(400).json({ error: 'No has conectado tu Gmail todavía' });

  try {
    const saved = [];

    // Busca en TODAS las cuentas conectadas (ej. si el contacto te escribió tanto a tu
    // correo de Bit Proximity como al de Bit WiFi) — se deduplica solo porque
    // gmail_message_id es único entre cuentas distintas de Google.
    for (const { gmail } of clients) {
      const { data: list } = await gmail.users.messages.list({
        userId: 'me',
        q: `from:${email} OR to:${email}`,
        maxResults: 20,
      });

      const messages = list.messages || [];

      for (const m of messages) {
        try {
          // format: 'full' en vez de 'metadata' — antes solo se guardaba snippet (el
          // fragmento corto de preview de Gmail), no el correo completo.
          const { data: full } = await gmail.users.messages.get({
            userId: 'me',
            id: m.id,
            format: 'full',
          });

          const headers = Object.fromEntries(
            (full.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value])
          );
          const { text: bodyText, html: bodyHtml } = extractBody(full.payload);

          // Algunos correos traen la fecha en un formato que Date() no puede parsear —
          // antes esto reventaba con "Invalid time value" y tumbaba TODA la sincronización
          // (no solo ese mensaje), porque estaba fuera de cualquier manejo de errores.
          let sentAt = null;
          if (headers.date) {
            const parsed = new Date(headers.date);
            if (!isNaN(parsed.getTime())) sentAt = parsed.toISOString();
          }

          const { data: row, error: upsertError } = await supabase
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
                body_text: bodyText,
                body_html: bodyHtml,
                sent_at: sentAt,
              },
              { onConflict: 'gmail_message_id' }
            )
            .select()
            .single();

          if (upsertError) continue;
          saved.push(row);
        } catch (msgErr) {
          // Un mensaje individual que falle (borrado en Gmail, formato inesperado, etc.)
          // no debe tumbar el resto de la sincronización.
          console.error('Error sincronizando un mensaje puntual:', m.id, msgErr.message);
        }
      }
    }

    res.json(saved);
  } catch (err) {
    console.error('Error sincronizando Gmail:', err);
    res.status(500).json({ error: `Error consultando Gmail: ${err.message}` });
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

// GET /api/gmail/contacts — lista los contactos de Google (People API) de TODAS las cuentas conectadas
router.get('/contacts', async (req, res) => {
  const { data: conns } = await supabase
    .from('gmail_connections')
    .select('refresh_token')
    .eq('team_member_id', req.teamMember.id)
    .order('id', { ascending: true });

  if (!conns || conns.length === 0) return res.status(400).json({ error: 'No has conectado tu Google todavía' });

  try {
    const seen = new Set(); // dedup por email entre cuentas
    const contacts = [];

    for (const conn of conns) {
      const client = getOAuthClient();
      client.setCredentials({ refresh_token: conn.refresh_token });
      const people = google.people({ version: 'v1', auth: client });

      const { data } = await people.people.connections.list({
        resourceName: 'people/me',
        pageSize: 500,
        personFields: 'names,emailAddresses,phoneNumbers,organizations',
      });

      let rawContacts = data.connections || [];

      // Si la libreta de Contactos está vacía (común en cuentas de trabajo),
      // usamos "Otros contactos" — la gente con la que Gmail detectó que
      // interactuaste, aunque no los hayas guardado explícitamente.
      if (rawContacts.length === 0) {
        const { data: otherData } = await people.otherContacts.list({
          pageSize: 500,
          readMask: 'names,emailAddresses,phoneNumbers',
        });
        rawContacts = otherData.otherContacts || [];
      }

      rawContacts
        .filter((p) => p.emailAddresses?.length)
        .forEach((p) => {
          const email = p.emailAddresses[0].value;
          if (seen.has(email)) return; // ya vino de otra cuenta conectada
          seen.add(email);
          contacts.push({
            first_name: p.names?.[0]?.givenName || p.names?.[0]?.displayName?.split(' ')[0] || 'Sin nombre',
            last_name: p.names?.[0]?.familyName || '',
            email,
            phone: p.phoneNumbers?.[0]?.value || null,
            company_name: p.organizations?.[0]?.name || null,
          });
        });
    }

    if (contacts.length === 0) {
      return res.status(404).json({ error: 'No se encontraron contactos con email en tus cuentas de Google conectadas.' });
    }

    res.json(contacts);
  } catch (err) {
    console.error('Error consultando Google Contacts:', err);
    res.status(500).json({ error: `Error consultando tus contactos de Google: ${err.message}` });
  }
});

// GET /api/gmail/calendar/events?days=14 — próximos eventos del calendario conectado
// (cuenta "principal" — la primera conectada; con varias cuentas conectadas, Calendar
// solo mira una para no mezclar eventos de dos calendarios distintos en una sola lista)
router.get('/calendar/events', async (req, res) => {
  const days = Number(req.query.days) || 14;

  const conn = await supabase
    .from('gmail_connections')
    .select('*')
    .eq('team_member_id', req.teamMember.id)
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();

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
    res.status(500).json({ error: `Error consultando el calendario: ${err.message}` });
  }
});

module.exports = router;
