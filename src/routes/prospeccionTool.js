// src/routes/prospeccionTool.js
//
// Backend de la herramienta "Prospección B2B" (prospeccion.bitproximity.com).
// Se monta en server.js con UNA línea nueva (junto a las otras rutas):
//
//   app.use('/api/prospeccion-tool', require('./routes/prospeccionTool'));
//
// Reemplaza al archivo anterior routes/prospecting.js que te di. NO uses ese
// nombre: tu CRM ya tenía su propio /api/prospecting (Lusha/Apollo) y yo lo
// había pisado. Restaura el original desde el historial de GitHub (ver guía).
//
// Seguridad: TODO pasa por requireAuth. Se autentica con la misma API key
// bitcrm_mcp_... (o sesión) que ya valida tu middleware/auth.js. Sin key
// válida no hay búsquedas ni acceso a leads — antes no había ninguna
// protección en el servidor.
//
// Lo que NO hace: leer ni escribir tratos del CRM. Eso lo hace la
// herramienta directo contra tu servidor MCP (/mcp) con la misma key.
//
// Variables de entorno (Railway):
//   ANTHROPIC_API_KEY   obligatoria para las búsquedas con IA
//   LUSHA_API_KEY       opcional — búsqueda de decisores con Lusha
//   APOLLO_API_KEY      opcional — búsqueda de decisores con Apollo
// Ya no hacen falta: BITCRM_SERVICE_API_KEY, BITCRM_BASE_URL.

const express = require('express');
const supabase = require('../config/supabase');
const auth = require('../middleware/auth');

// Tolera que auth exporte { requireAuth } o la función directa, y que sea
// un middleware (req,res,next) o una fábrica requireAuth().
const mw = typeof auth.requireAuth === 'function' ? auth.requireAuth : auth;
const guard = mw.length >= 3 ? mw : mw();

const fetchFn = global.fetch || require('node-fetch');
const router = express.Router();
router.use(guard);

const who = (req) =>
  (req.teamMember && (req.teamMember.email || req.teamMember.name)) ||
  (req.user && req.user.email) || 'equipo';

// ---------------------------------------------------------------------------
// Límite simple por persona: 40 búsquedas con IA cada 10 minutos
// ---------------------------------------------------------------------------
const hits = new Map();
function limited(key) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (arr.length >= 40) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr);
  return false;
}

// Solo servidores MCP permitidos — el navegador manda un nombre, nunca una URL.
const MCP = {
  lusha: { url: 'https://mcp.lusha.com/mcp/claude', env: 'LUSHA_API_KEY' },
  apollo: { url: 'https://mcp.apollo.io/mcp', env: 'APOLLO_API_KEY' },
};

// ---------------------------------------------------------------------------
// POST /search  — proxy a Claude (Haiku) con web_search y/o Lusha/Apollo
// ---------------------------------------------------------------------------
router.post('/search', async (req, res) => {
  try {
    const { prompt, servers, web } = req.body || {};
    if (!prompt || typeof prompt !== 'string' || prompt.length > 6000) {
      return res.status(400).json({ error: { message: 'Falta "prompt" (máx. 6000 caracteres).' } });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: { message: 'Falta ANTHROPIC_API_KEY en Railway.' } });
    }
    if (limited(who(req))) {
      return res.status(429).json({ error: { message: 'Demasiadas búsquedas seguidas. Espera unos minutos.' } });
    }

    const body = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    };

    const mcpServers = [];
    for (const name of Array.isArray(servers) ? servers.slice(0, 2) : []) {
      const def = MCP[String(name).toLowerCase()];
      if (!def) return res.status(400).json({ error: { message: `Fuente desconocida: ${name}` } });
      const token = process.env[def.env];
      if (!token) return res.status(400).json({ error: { message: `Falta ${def.env} en Railway para buscar con ${name}.` } });
      mcpServers.push({ type: 'url', url: def.url, name: String(name).toLowerCase(), authorization_token: token });
    }
    if (mcpServers.length) body.mcp_servers = mcpServers;
    if (web) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 110000);
    const r = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'mcp-client-2025-04-04',
      },
      body: JSON.stringify(body),
    }).finally(() => clearTimeout(timer));

    const data = await r.json();
    if (!r.ok) {
      console.error('Anthropic API error:', JSON.stringify(data).slice(0, 500));
      return res.status(r.status).json(data);
    }
    res.json(data);
  } catch (err) {
    console.error('prospeccion-tool /search:', err);
    res.status(err.name === 'AbortError' ? 504 : 500).json({
      error: { message: err.name === 'AbortError' ? 'La búsqueda tardó demasiado. Intenta de nuevo.' : 'Error interno en la búsqueda.' },
    });
  }
});

// ---------------------------------------------------------------------------
// Leads compartidos del equipo (opcional) — tabla prospecting_leads
// Corre antes la migración 052_prospecting_leads.sql en el Supabase del CRM.
// Cada lead se guarda completo como JSON; gana la versión más reciente.
// ---------------------------------------------------------------------------
router.get('/leads', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('prospecting_leads')
      .select('data')
      .order('updated_at', { ascending: false })
      .limit(5000);
    if (error) throw error;
    res.json({ leads: (data || []).map((r) => r.data) });
  } catch (err) {
    console.error('prospeccion-tool GET /leads:', err);
    res.status(500).json({ error: 'No se pudieron leer los leads del equipo.' });
  }
});

router.post('/leads/bulk', async (req, res) => {
  try {
    const incoming = Array.isArray(req.body && req.body.leads) ? req.body.leads : [];
    if (!incoming.length) return res.json({ saved: 0 });
    if (incoming.length > 500) return res.status(400).json({ error: 'Máximo 500 leads por envío.' });
    const clean = incoming.filter((l) => l && typeof l.id === 'string' && l.id.length < 80);

    // No pisar una versión más nueva que ya está en el servidor
    const ids = clean.map((l) => l.id);
    const { data: existing, error: e1 } = await supabase
      .from('prospecting_leads').select('id, updated_at').in('id', ids);
    if (e1) throw e1;
    const have = new Map((existing || []).map((r) => [r.id, new Date(r.updated_at).getTime()]));

    const rows = clean
      .filter((l) => (l.updatedAt || 0) >= (have.get(l.id) || 0))
      .map((l) => ({
        id: l.id,
        data: l,
        updated_at: new Date(l.updatedAt || Date.now()).toISOString(),
        updated_by: who(req),
      }));
    if (rows.length) {
      const { error } = await supabase.from('prospecting_leads').upsert(rows, { onConflict: 'id' });
      if (error) throw error;
    }
    res.json({ saved: rows.length });
  } catch (err) {
    console.error('prospeccion-tool POST /leads/bulk:', err);
    res.status(500).json({ error: 'No se pudieron guardar los leads.' });
  }
});

module.exports = router;
