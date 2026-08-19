// src/routes/prospecting.js
//
// Se monta en server.js como:
//   app.use('/api/prospecting', require('./routes/prospecting'));
// Por eso las rutas de abajo son '/search', '/save-to-crm', '/pipeline-snapshot'
// (SIN repetir '/api/prospecting' — ese prefijo ya lo pone el app.use).
//
// El CORS lo maneja el middleware global de server.js (FRONTEND_ORIGIN) —
// a propósito NO se repite acá para no duplicar/pisar esos headers.

const express = require('express');
const fetch = require('node-fetch'); // si usas Node 18+, puedes usar el fetch global y borrar esta línea

const router = express.Router();

// ---------------------------------------------------------------------------
// 1) Instalación
// ---------------------------------------------------------------------------
// En bit-crm-backend:
//   npm install node-fetch@2   (si no lo tienes ya; "express" ya lo tienes)
//
// Variable de entorno en Railway (Settings → Variables):
//   ANTHROPIC_API_KEY=sk-ant-...
// (la consigues en console.anthropic.com → API Keys — cuenta de developer,
// distinta a tu login normal de Claude.ai)
//
// Y confirma que FRONTEND_ORIGIN incluya tu dominio nuevo:
//   FRONTEND_ORIGIN=https://crm.bitproximity.com,https://prospeccion.bitproximity.com

// ---------------------------------------------------------------------------
// 2) Proxy hacia la API de Anthropic (búsqueda con Apollo/Lusha, Maps/web,
//    Instagram, LinkedIn, señales de intención)
// ---------------------------------------------------------------------------
router.post('/search', async (req, res) => {
  try {
    const { prompt, mcp_servers, tools } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Falta el campo "prompt" en el body.' });
    }

    // El navegador manda solo la URL/nombre de cada servidor MCP — el token
    // de autorización de cada servicio (Lusha, Apollo) se agrega acá, del
    // lado del servidor, para no exponerlo nunca al cliente. Sin esto,
    // Anthropic no puede autenticarse contra Lusha/Apollo y responde 400
    // "Authentication error while communicating with MCP server".
    //
    // Variables de entorno necesarias en Railway:
    //   LUSHA_API_KEY=...   (Lusha → Settings → API → API Keys)
    //   APOLLO_API_KEY=...  (Apollo → Settings → Integrations → API)
    let finalMcpServers = mcp_servers;
    if (mcp_servers) {
      finalMcpServers = mcp_servers.map((server) => {
        if (server.name === 'lusha' && process.env.LUSHA_API_KEY) {
          return { ...server, authorization_token: process.env.LUSHA_API_KEY };
        }
        if (server.name === 'apollo' && process.env.APOLLO_API_KEY) {
          return { ...server, authorization_token: process.env.APOLLO_API_KEY };
        }
        return server;
      });
    }

    const body = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    };
    if (finalMcpServers) body.mcp_servers = finalMcpServers;
    if (tools) body.tools = tools;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'mcp-client-2025-04-04' // habilita mcp_servers en la API
      },
      body: JSON.stringify(body)
    });

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      console.error('Anthropic API error:', data);
      return res.status(anthropicRes.status).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: 'Error interno en el proxy de prospección.' });
  }
});

// ---------------------------------------------------------------------------
// 3) Opcional — agregar un prospecto a una Lista de Bit CRM
// ---------------------------------------------------------------------------
// ESQUELETO: reemplaza el bloque TODO con la lógica real de import a la
// lista "Prospección B2B" que ya tienes en Bit CRM.
router.post('/save-to-crm', async (req, res) => {
  try {
    const { list, company, contact, email, phone, country, industry, product, source } = req.body;

    if (!company) {
      return res.status(400).json({ error: 'Falta "company" en el body.' });
    }

    // TODO: reemplaza esto por tu lógica real, por ejemplo:
    //   const targetList = await ListService.findOrCreateByName(list || 'Prospección B2B');
    //   const newContact = await ContactService.create({ firstName: contact, email, phone, companyName: company, country });
    //   await ListService.addContact(targetList.id, newContact.id);
    //   return res.json({ list: targetList, contact: newContact });

    console.log('Agregar a lista de Bit CRM (pendiente de conectar a tu lógica real):', {
      list, company, contact, email, phone, country, industry, product, source
    });

    res.status(501).json({
      error: 'Endpoint no conectado todavía — reemplaza el TODO con tu lógica real de import a lista.'
    });
  } catch (err) {
    console.error('Error guardando en la lista de Bit CRM:', err);
    res.status(500).json({ error: 'Error interno guardando en la lista.' });
  }
});

// ---------------------------------------------------------------------------
// 4) Opcional — leer el pipeline en vivo en vez de la foto fija del HTML
// ---------------------------------------------------------------------------
router.get('/pipeline-snapshot', async (req, res) => {
  try {
    // TODO: reemplaza esto por tu consulta real, por ejemplo:
    //   const deals = await DealService.listOpen({ withContact: true });
    //   return res.json(deals);

    res.status(501).json({
      error: 'Endpoint no conectado todavía — reemplaza el TODO con tu consulta real de deals abiertos.'
    });
  } catch (err) {
    console.error('Error leyendo pipeline:', err);
    res.status(500).json({ error: 'Error interno leyendo el pipeline.' });
  }
});

// ---------------------------------------------------------------------------
// 5) Opcional — historial de "ya contactado" (evita que el equipo duplique outreach)
// ---------------------------------------------------------------------------
// Reemplaza el window.storage de Claude.ai por tu propia base — funciona sin
// importar dónde esté hospedado el HTML. Usa Supabase (ya lo tienes importado
// en middleware/auth.js con el mismo patrón).
//
// Antes de usar esto, crea la tabla en Supabase (SQL Editor):
//
//   create table prospecting_contacted (
//     key text primary key,
//     company text not null,
//     channel text,
//     step int,
//     contacted_at timestamptz not null default now()
//   );
//
// Y en el HTML, configura:
//   const CONTACTED_API_URL = 'https://bit-crm-backend-production.up.railway.app/api/prospecting/contacted';
const supabase = require('../config/supabase');

router.get('/contacted', async (req, res) => {
  try {
    const { data, error } = await supabase.from('prospecting_contacted').select('*');
    if (error) throw error;
    const contacted = {};
    (data || []).forEach(row => {
      contacted[row.key] = { company: row.company, channel: row.channel, step: row.step, at: row.contacted_at };
    });
    res.json({ contacted });
  } catch (err) {
    console.error('Error leyendo historial de contacto:', err);
    res.status(500).json({ error: 'Error interno leyendo el historial de contacto.' });
  }
});

router.post('/contacted', async (req, res) => {
  try {
    const { key, company, channel, step, at } = req.body;
    if (!key || !company) {
      return res.status(400).json({ error: 'Faltan "key" o "company" en el body.' });
    }
    const { error } = await supabase.from('prospecting_contacted').upsert({
      key, company, channel, step, contacted_at: at || new Date().toISOString()
    });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('Error guardando historial de contacto:', err);
    res.status(500).json({ error: 'Error interno guardando el historial de contacto.' });
  }
});

module.exports = router;
