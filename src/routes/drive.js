const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { google } = require('googleapis');
const { getOAuthClient } = require('../config/googleOAuth');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// Reusa las mismas cuentas de Google conectadas para Gmail (gmail_connections) — el
// refresh_token ya trae el scope de Drive desde que se agregó a GMAIL_SCOPES, así que
// cualquiera que reconecte su cuenta una vez queda con Drive habilitado también, sin un
// flujo de conexión aparte.
async function getAllDriveClientsForUser(teamMemberId) {
  const { data: conns } = await supabase
    .from('gmail_connections')
    .select('*')
    .eq('team_member_id', teamMemberId)
    .order('id', { ascending: true });

  return (conns || []).map((conn) => {
    const client = getOAuthClient();
    client.setCredentials({ refresh_token: conn.refresh_token });
    return { email: conn.email, drive: google.drive({ version: 'v3', auth: client }) };
  });
}

// GET /api/drive/search?q=... — busca por nombre en todas las cuentas de Drive conectadas
router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.json([]);

  const clients = await getAllDriveClientsForUser(req.teamMember.id);
  if (clients.length === 0) return res.status(400).json({ error: 'No tienes una cuenta de Google conectada. Conectala desde Mi Perfil.' });

  try {
    let results = [];
    for (const { email, drive } of clients) {
      const { data } = await drive.files.list({
        q: `name contains '${q.replace(/'/g, "\\'")}' and trashed = false`,
        fields: 'files(id, name, mimeType, iconLink, webViewLink, modifiedTime)',
        pageSize: 10,
        orderBy: 'modifiedTime desc',
      });
      results = results.concat((data.files || []).map((f) => ({ ...f, account: email })));
    }
    res.json(results);
  } catch (err) {
    // Token sin el scope de Drive todavia (cuenta conectada antes de agregarlo) — mensaje
    // claro en vez del error crudo de Google.
    if (/insufficient|scope/i.test(err.message || '')) {
      return res.status(400).json({ error: 'Tu conexión con Google es de antes de tener Drive habilitado — reconectala en Mi Perfil.' });
    }
    res.status(400).json({ error: err.message });
  }
});

// GET /api/drive/:entity_type/:entity_id — archivos ya vinculados a este trato/contacto/empresa
router.get('/:entity_type/:entity_id', async (req, res) => {
  const { entity_type, entity_id } = req.params;
  const { data, error } = await supabase
    .from('drive_files')
    .select('*')
    .eq('entity_type', entity_type)
    .eq('entity_id', entity_id)
    .order('linked_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// POST /api/drive/:entity_type/:entity_id — vincula un archivo elegido en la búsqueda
router.post('/:entity_type/:entity_id', async (req, res) => {
  const { entity_type, entity_id } = req.params;
  const { drive_file_id, name, mime_type, icon_link, web_view_link } = req.body;
  if (!drive_file_id) return res.status(400).json({ error: 'Falta drive_file_id' });

  const { data, error } = await supabase
    .from('drive_files')
    .insert({ entity_type, entity_id, team_member_id: req.teamMember.id, drive_file_id, name, mime_type, icon_link, web_view_link })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// DELETE /api/drive/link/:id — desvincula (no borra el archivo real de Drive)
router.delete('/link/:id', async (req, res) => {
  const { error } = await supabase.from('drive_files').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).end();
});

module.exports = router;
