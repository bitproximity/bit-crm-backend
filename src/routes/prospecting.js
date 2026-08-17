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

    const body = {
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    };
    if (mcp_servers) body.mcp_servers = mcp_servers;
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

module.exports = router;
