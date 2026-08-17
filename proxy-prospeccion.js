// proxy-prospeccion.js
//
// Por qué existe esto:
// El Motor de Prospección (reactivacion-deals.html) hace fetch() a una API
// externa desde el navegador. Eso SOLO funciona sin configuración cuando el
// archivo se abre dentro de Claude.ai (el visor de artefactos intercepta y
// autentica esa llamada). En cuanto lo hospedas afuera (Cloudflare Pages,
// tu dominio propio) y lo abres como página normal, el navegador bloquea la
// llamada directa a api.anthropic.com — no hay API key ni permiso de CORS.
// Por eso el error "Failed to fetch".
//
// La solución: este endpoint vive en TU backend (bit-crm-backend en
// Railway), guarda tu Anthropic API key del lado del servidor, y reenvía la
// petición. El HTML deja de llamar a api.anthropic.com directamente y llama
// a este endpoint en su lugar.
//
// De paso, este archivo trae dos endpoints extra (opcionales) para conectar
// el Motor de Prospección directo con tu Bit CRM: guardar un prospecto
// encontrado como contacto/deal real, y leer el pipeline en vivo en vez de
// depender de la foto fija que trae el HTML.

const express = require('express');
const fetch = require('node-fetch'); // si usas Node 18+, puedes usar el fetch global y borrar esta línea

const router = express.Router();

// CORS a mano — sin depender del paquete "cors". Cerrado al dominio real
// donde vive la herramienta. Si tu server.js ya tiene otro middleware de
// CORS más restrictivo antes de este, ese va a ganar; revisa que no exista
// un app.use(cors(...)) global con otro origin antes de montar este router.
router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://prospeccion.bitproximity.com');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204); // responde el preflight de inmediato, sin tocar nada más
  }
  next();
});

// ---------------------------------------------------------------------------
// 1) Instalación
// ---------------------------------------------------------------------------
// En bit-crm-backend:
//   npm install express cors node-fetch@2   (si no los tienes ya)
//
// Variable de entorno en Railway (Settings → Variables):
//   ANTHROPIC_API_KEY=sk-ant-...
// (la consigues en console.anthropic.com → API Keys — es la cuenta de
// developer, distinta a tu login normal de Claude.ai)

// ---------------------------------------------------------------------------
// 2) Proxy hacia la API de Anthropic (búsqueda con Apollo/Lusha y Maps/web)
// ---------------------------------------------------------------------------
router.post('/api/prospecting-search', async (req, res) => {
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
// Ya tienes en Bit CRM la sección "Listas", con una lista "Prospección B2B"
// esperando contactos, y el texto ahí mismo dice "las listas creadas al
// importar desde Prospección aparecen automáticamente aquí" — eso sugiere
// que ya existe (o está pensado) un mecanismo de import específico para
// esto en tu backend. Este endpoint es el punto donde el Motor de
// Prospección entrega cada contacto que Mario decide guardar (uno por uno,
// con el botón "+ Lista Prospección" — nunca en bulk automático).
//
// ESQUELETO: reemplaza el bloque TODO con la llamada real a esa lógica de
// import-a-lista que ya existe (o, si todavía no existe del todo, con la
// creación de contacto + asociación a la lista por nombre/id).
router.post('/api/prospecting-save-to-crm', async (req, res) => {
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
      error: 'Endpoint no conectado todavía — reemplaza el TODO en proxy-prospeccion.js con tu lógica real de import a lista.'
    });
  } catch (err) {
    console.error('Error guardando en la lista de Bit CRM:', err);
    res.status(500).json({ error: 'Error interno guardando en la lista.' });
  }
});

// ---------------------------------------------------------------------------
// 4) Opcional — leer el pipeline en vivo en vez de la foto fija del HTML
// ---------------------------------------------------------------------------
// Esqueleto para que el Motor de Prospección lea tus deals reales al
// cargar, en vez de la lista fija que Claude generó en su momento.
// Reemplaza el TODO por la consulta real a tu base (la misma que usa
// bitcrm_list_deals en tu servidor MCP).
router.get('/api/prospecting-pipeline-snapshot', async (req, res) => {
  try {
    // TODO: reemplaza esto por tu consulta real, por ejemplo:
    //   const deals = await DealService.listOpen({ withContact: true });
    //   return res.json(deals);

    res.status(501).json({
      error: 'Endpoint no conectado todavía — reemplaza el TODO en proxy-prospeccion.js con tu consulta real de deals abiertos.'
    });
  } catch (err) {
    console.error('Error leyendo pipeline:', err);
    res.status(500).json({ error: 'Error interno leyendo el pipeline.' });
  }
});

module.exports = router;

// ---------------------------------------------------------------------------
// 5) Cómo montarlo
// ---------------------------------------------------------------------------
// En tu server.js principal:
//   const prospectingRouter = require('./proxy-prospeccion');
//   app.use(prospectingRouter);
//
// ---------------------------------------------------------------------------
// 6) Cambios necesarios en reactivacion-deals.html
// ---------------------------------------------------------------------------
// Busca estas líneas cerca del inicio del <script>:
//   const PROSPECTING_API_URL = 'https://api.anthropic.com/v1/messages';
//   const BITCRM_SAVE_URL = '';
//   const BITCRM_LIST_NAME = 'Prospección B2B';
// y cámbialas por las URLs de tu backend, por ejemplo:
//   const PROSPECTING_API_URL = 'https://bit-crm-backend-production.up.railway.app/api/prospecting-search';
//   const BITCRM_SAVE_URL = 'https://bit-crm-backend-production.up.railway.app/api/prospecting-save-to-crm';
// El resto del archivo ya está preparado para usar esas constantes.
//
// ---------------------------------------------------------------------------
// Nota de seguridad
// ---------------------------------------------------------------------------
// Con origin: '*' cualquiera que tenga la URL del proxy puede usarlo y
// consumir tu API key de Anthropic, o crear registros en tu CRM. Para
// producción, cambia el origin al dominio real donde hospedes el HTML, y
// considera agregar autenticación simple (ej. un header secreto) y un rate
// limit (ej. express-rate-limit) para evitar abuso.
