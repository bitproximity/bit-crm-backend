require('dotenv').config();
// Parchea Express para que un error lanzado (o una promesa rechazada) dentro de una
// ruta async se reenvíe solo al manejador de errores de abajo. Sin esto, un error
// inesperado en CUALQUIER ruta (no un error normal de negocio, sino algo imprevisto)
// dejaba la petición colgada para siempre sin responder nada — ni éxito ni error —
// y el navegador se quedaba cargando indefinidamente. Debe ir antes de requerir
// cualquier router.
require('express-async-errors');
const express = require('express');
const helmet = require('helmet');
const { apiLimiter, publicFormSubmitLimiter, publicReadLimiter } = require('./middleware/rateLimits');
const { jsonBodyParser } = require('./middleware/bodyLimits');
const errorHandler = require('./middleware/errorHandler');
const { buildCorsPolicy } = require('./middleware/corsPolicy');
const compression = require('compression');
const { clearAll: clearMemo } = require('./utils/memo');
const { clearAuthCache } = require('./middleware/auth');
const requestTiming = require('./utils/requestTiming');

const app = express();

// Railway hace terminación TLS en su borde y le manda al proceso tráfico
// plano por dentro — sin esto, req.protocol siempre da 'http' aunque el
// sitio público sea https, y rompe las URLs que arma el stub de OAuth.
app.set('trust proxy', true);
app.disable('x-powered-by');
// Cabeceras de seguridad (no-sniff, HSTS, referrer, etc.). Sin CSP: esto es una API JSON, no sirve páginas.
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' }, crossOriginOpenerPolicy: false }));

// El servidor MCP y sus endpoints de OAuth deben responder a cualquier origen
// (Claude.ai los consulta directo desde el navegador al conectar el conector) —
// van montados ANTES del CORS restringido a crm.bitproximity.com de abajo, para
// que ese CORS restrictivo no les bloquee las peticiones.
app.use('/', require('./routes/oauth'));

const cors = buildCorsPolicy(process.env.FRONTEND_ORIGIN);
if (cors.wildcard) {
  console.warn('[seguridad] FRONTEND_ORIGIN no está definido: la API acepta peticiones desde CUALQUIER sitio web. Defínelo en Railway (ej. https://crm.bitproximity.com); los formularios públicos seguirán funcionando desde otros sitios.');
}
app.use(cors.handler);
app.use(requestTiming.middleware);
// Compresión de respuestas (gzip/brotli): una lista de tratos pasa de ~106 KB a ~17 KB, y las
// respuestas del dashboard/pipelines/empresas a una décima parte. No se toca /mcp ni nada que
// sea un flujo (text/event-stream), y los archivos ya comprimidos (PDF, imágenes) se saltan solos.
app.use(
  compression({
    filter: (req, res) => {
      if (req.path.startsWith('/mcp') || req.headers['x-no-compression']) return false;
      return compression.filter(req, res);
    },
  })
);
// Límites de cuerpo por ruta (ver middleware/bodyLimits.js)
app.use(jsonBodyParser);
app.use(express.urlencoded({ limit: '2mb', extended: true }));

// Límites de peticiones (públicas más estrictas que la API con sesión)
app.use('/api/public/lead-forms', (req, res, next) => (req.method === 'POST' ? publicFormSubmitLimiter : publicReadLimiter)(req, res, next));
app.use('/api/public', publicReadLimiter);
app.use(['/api', '/mcp'], apiLimiter);

// El CRM es datos en vivo — nunca debería quedar una respuesta vieja guardada en el
// camino (navegador, o un proxy/CDN como Cloudflare delante de Railway). Esta cabecera
// es la señal "oficial" HTTP que cualquiera de esas capas debe respetar para no
// reusar una respuesta anterior, a diferencia de "cache: no-store" del lado del
// navegador, que solo controla el caché del propio navegador.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

// Cualquier escritura vacía la caché de corta vida (utils/memo.js): quien guarda un cambio nunca
// ve datos viejos en la siguiente lectura. Se vacía al empezar y al terminar la escritura, y las
// lecturas que estaban en vuelo en ese momento no se guardan. Las búsquedas (POST pero de solo
// lectura) no vacían nada. Si cambia un usuario, su rol/bloqueos o una API key, también se
// olvida lo recordado de las sesiones, para que el cambio se aplique de inmediato.
const READ_ONLY_POSTS = new Set(['/api/prospecting/search', '/api/prospeccion-tool/search']);
const AUTH_AFFECTING = /^\/api\/(team|mcp-keys|role-permissions)/;
app.use((req, res, next) => {
  const isWrite = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE';
  if (isWrite && !READ_ONLY_POSTS.has(req.path)) {
    const flush = () => {
      clearMemo();
      if (AUTH_AFFECTING.test(req.originalUrl) || req.path === '/mcp') clearAuthCache();
    };
    flush();
    res.on('finish', flush);
  }
  next();
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/team', require('./routes/team'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/companies', require('./routes/companies'));
app.use('/api/duplicates', require('./routes/duplicates'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/automation-rules', require('./routes/automationRules'));
app.use('/api/quotas', require('./routes/quotas'));
app.use('/api/role-permissions', require('./routes/rolePermissions'));
app.use('/api/pipelines', require('./routes/pipelines'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/enrichment', require('./routes/enrichment'));
app.use('/api/prospecting', require('./routes/prospecting'));
app.use('/api/prospeccion-tool', require('./routes/prospeccionTool'));
app.use('/api/deals', require('./routes/deals'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/tags', require('./routes/tags'));
app.use('/api/activities', require('./routes/activities'));
app.use('/api/templates', require('./routes/templates'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/custom-fields', require('./routes/customFields'));
app.use('/api/exchange-rates', require('./routes/exchangeRates'));
app.use('/api/gmail', require('./routes/gmail'));
app.use('/api/drive', require('./routes/drive'));
app.use('/api/products', require('./routes/products'));
app.use('/api/forecast', require('./routes/forecast'));
app.use('/api/metrics', require('./routes/metrics'));
app.use('/api/insights', require('./routes/insights'));
app.use('/api/calcom', require('./routes/calcom'));
app.use('/api/mcp-keys', require('./routes/mcpKeys'));
app.use('/api/spaces', require('./routes/spaces'));
app.use('/api/documents', require('./routes/documents'));
// El import va ANTES: «/api/invoices/import/…» no debe caer en las rutas /:id de invoices
app.use('/api/finance', require('./routes/finance'));
app.use('/api/stale-deals', require('./routes/staleDeals'));
app.use('/api/invoices/import', require('./routes/invoiceImport'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/invoice-sync', require('./routes/invoiceSync'));
app.use('/api/invoice-sync', require('./routes/facturermovilSync'));
app.use('/api/deal-files', require('./routes/dealFiles'));
app.use('/api/document-files', require('./routes/documentFiles'));
app.use('/api/b2b', require('./routes/b2b'));
app.use('/api/public/b2b', require('./routes/publicB2b'));
app.use('/api/public/lead-forms', require('./routes/publicLeadForms'));
app.use('/api/lead-forms', require('./routes/leadForms'));

// ── Servidor MCP: conecta Claude Desktop/API a Bit CRM ──
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { buildServer } = require('./mcp/server');
const { requireAuth: mcpAuth } = require('./middleware/auth');

// El MCP ejecuta consultas directas a la base (no pasa por los permisos de cada pantalla), así que solo lo usan administración y operaciones.
// Antes cualquier persona con sesión (incluido el socio externo) podía crear una clave y operar sin restricciones.
const MCP_ROLES = ['admin', 'operaciones'];

app.post('/mcp', mcpAuth, async (req, res) => {
  if (!MCP_ROLES.includes(req.teamMember?.role)) return res.status(403).json({ error: 'El acceso MCP está disponible solo para administración y operaciones.' });
  try {
    const server = buildServer(req.teamMember);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('Error en /mcp:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Error interno del servidor MCP' });
  }
});

// Manejo de errores no capturados
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bit CRM backend corriendo en el puerto ${PORT}`);
});

const { startInvoiceScheduler } = require('./utils/invoiceScheduler');
startInvoiceScheduler();

const { startExchangeRateScheduler } = require('./utils/exchangeRateScheduler');
startExchangeRateScheduler();

const { startStaleDealsScheduler } = require('./utils/staleDealsScheduler');
startStaleDealsScheduler();

const { startStaleRemindersScheduler } = require('./utils/staleRemindersScheduler');
startStaleRemindersScheduler();
