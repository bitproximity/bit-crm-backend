// Seguridad: lo que antes estaba abierto (formulario público, correos con HTML ajeno, cuerpos de 50 MB, claves MCP de cualquier rol,
// herramientas MCP que borran sin pedir rol) y que ahora debe estar cerrado.
const http = require('http'); const path = require('path'); const Module = require('module');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const { createFakeDb, install } = require('./fakeSupabase');
const fake = createFakeDb();
const restore = install(fake);

// El correo y las notificaciones se capturan en vez de enviarse
const sent = [];
const stub = (rel, exports_) => { const f = require.resolve(rel); require.cache[f] = { id: f, filename: f, loaded: true, exports: exports_ }; };
stub('../src/utils/email', { sendEmail: async (m) => { sent.push(m); } });
stub('../src/utils/notify', { createNotification: async (n) => { fake.db.notifications.push(n); } });

const express = require(path.resolve(__dirname, '../node_modules/express'));
const { escapeHtml, escapeLike, escapeIlikeValue } = require('../src/utils/escape');
const { fileUrls } = require('../src/utils/fileUrls');
const { jsonBodyParser } = require('../src/middleware/bodyLimits');
const errorHandler = require('../src/middleware/errorHandler');
const { publicFormSubmitLimiter, publicReadLimiter, makeApiLimiter } = require('../src/middleware/rateLimits');

// ── 1) texto que escribe una persona ────────────────────────────────────────────────────────────────
ok(escapeHtml('<a href="http://malo">clic</a> & "x" \'y\'') === '&lt;a href=&quot;http://malo&quot;&gt;clic&lt;/a&gt; &amp; &quot;x&quot; &#39;y&#39;', 'escapeHtml convierte HTML en texto (un enlace falso deja de ser un enlace)');
ok(escapeHtml(null) === '' && escapeHtml(undefined) === '' && escapeHtml(42) === '42', 'escapeHtml tolera vacío y números');
ok(escapeLike('ana,id.not.is.null') === 'ana id.not.is.null' && !/[,()]/.test(escapeLike('a),(b')), 'escapeLike: la coma y los paréntesis (sintaxis del filtro) no pasan: no se pueden agregar condiciones');
ok(escapeLike('50%_off') === '50\\%\\_off' && escapeLike('  a   b  ') === 'a b' && escapeLike('x'.repeat(500)).length === 100, 'escapeLike: escapa los comodines, compacta espacios y limita el largo');
ok(escapeLike('"quoted\' `x` \\') === 'quoted x', 'escapeLike: comillas, acentos graves y barras fuera');
ok(escapeIlikeValue('Acme, Inc. (LLC)') === 'Acme, Inc. (LLC)' && escapeIlikeValue('50%_x\\y') === '50\\%\\_x\\\\y', 'escapeIlikeValue: la puntuación de un nombre se conserva; solo se escapan los comodines');

// ── 2) enlaces a archivos ───────────────────────────────────────────────────────────────────────────
(async () => {
  const mkSupa = (signedFails) => ({ storage: { from: () => ({
    createSignedUrls: async (paths) => (signedFails ? { data: null, error: { message: 'x' } } : { data: paths.map((p) => ({ path: p, signedUrl: `https://s/${p}?token=abc` })), error: null }),
    getPublicUrl: (p) => ({ data: { publicUrl: `https://s/public/${p}` } }),
  }) } });
  let u = await fileUrls(mkSupa(false), 'deal-files', ['a/1.pdf', 'a/1.pdf', 'b/2.pdf', null]);
  ok(Object.keys(u).length === 2 && u['a/1.pdf'] === 'https://s/a/1.pdf?token=abc', 'los archivos se sirven con enlace FIRMADO (con vencimiento), sin repetir ni incluir vacíos');
  u = await fileUrls(mkSupa(true), 'deal-files', ['a/1.pdf']);
  ok(u['a/1.pdf'] === 'https://s/public/a/1.pdf', 'si la firma falla, se cae al enlace público para no romper la descarga');
  ok(Object.keys(await fileUrls(mkSupa(false), 'x', [])).length === 0, 'sin archivos no hace ninguna petición');
})();

// ── 3) límites de cuerpo y manejo de errores ────────────────────────────────────────────────────────
const post = (port, p, body, headers = {}) => new Promise((resolve) => {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  const req = http.request({ port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, (res) => {
    let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* no es JSON */ } resolve({ status: res.statusCode, json: j, text: s }); });
  });
  req.on('error', () => resolve({ status: 0, json: null, text: '' }));
  req.write(data); req.end();
});
const get = (port, p, headers = {}) => new Promise((resolve) => { http.get({ port, path: p, headers }, (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* */ } resolve({ status: res.statusCode, json: j }); }); }); });

const limApp = express();
limApp.use(jsonBodyParser);
limApp.post('*', (req, res) => res.json({ ok: true, bytes: JSON.stringify(req.body).length }));
limApp.get('/boom', () => { throw new Error('relation "invoices" does not exist at SELECT secret_column'); });
limApp.use(errorHandler);
const limSrv = limApp.listen(0, async () => {
  const port = limSrv.address().port;
  const big = (kb) => ({ x: 'a'.repeat(kb * 1024) });
  let r = await post(port, '/api/public/lead-forms/f/submit', big(100));
  ok(r.status === 413 && r.json.error === 'El envío es demasiado grande.', 'una ruta pública rechaza cuerpos de más de 64 KB (antes aceptaba hasta 50 MB de cualquiera)');
  r = await post(port, '/api/public/lead-forms/f/submit', big(10)); ok(r.status === 200, '…pero un formulario normal pasa');
  r = await post(port, '/api/contacts', big(3 * 1024)); ok(r.status === 413, 'el resto de la API rechaza más de 2 MB');
  r = await post(port, '/api/prospeccion-tool/leads/bulk', big(3 * 1024)); ok(r.status === 200, 'la carga masiva de la herramienta de prospección también admite cuerpos grandes');
  r = await post(port, '/api/deals', big(500)); ok(r.status === 200, '…y acepta lo normal');
  r = await post(port, '/api/contacts/import', big(3 * 1024)); ok(r.status === 200, 'las importaciones sí admiten cuerpos grandes');
  r = await post(port, '/api/invoices/import/parse', big(3 * 1024)); ok(r.status === 200, 'leer PDFs de facturas también');
  r = await post(port, '/api/documents', big(3 * 1024)); ok(r.status === 200, 'y los documentos (llevan imágenes)');
  r = await post(port, '/api/public/b2b/x', '{no es json'); ok(r.status === 400 && r.json.error === 'El cuerpo de la petición no es un JSON válido.', 'un JSON roto da un 400 claro (antes un 500)');
  r = await get(port, '/boom');
  ok(r.status === 500 && r.json.error === 'Error interno del servidor' && !JSON.stringify(r.json).includes('secret_column'), 'un error inesperado NO filtra detalles internos (tablas, columnas, consultas)');
  limSrv.close();
});

// ── 3b) CORS: qué sitios web pueden llamar a la API ─────────────────────────────────────────────────
const { buildCorsPolicy, FIRST_PARTY_ORIGINS } = require('../src/middleware/corsPolicy');
const preflight = (port, p, origin) => new Promise((resolve) => {
  const req = http.request({ port, path: p, method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, acao: res.headers['access-control-allow-origin'] || null })); });
  req.end();
});
const corsCheck = async (envValue) => {
  const app = express(); app.use(buildCorsPolicy(envValue).handler); app.all('*', (req, res) => res.json({ ok: true }));
  const srv = await new Promise((r) => { const s2 = app.listen(0, () => r(s2)); }); const port = srv.address().port; const out = {};
  for (const [k, o, p] of [['crm', 'https://crm.bitproximity.com', '/api/deals'], ['prospeccion_api', 'https://prospeccion.bitproximity.com', '/api/prospeccion-tool/leads'], ['prospeccion_mcp', 'https://prospeccion.bitproximity.com', '/mcp'], ['ajeno', 'https://sitio-malo.test', '/api/deals'], ['ajeno_publico', 'https://sitio-malo.test', '/api/public/lead-forms/x/submit'], ['extra', 'https://otro.bitproximity.com', '/api/deals']]) out[k] = await preflight(port, p, o);
  srv.close(); return out;
};
(async () => {
  ok(FIRST_PARTY_ORIGINS.includes('https://prospeccion.bitproximity.com') && FIRST_PARTY_ORIGINS.includes('https://crm.bitproximity.com'), 'los sitios propios (CRM y Prospección B2B) están en la lista fija');
  let c = await corsCheck('https://crm.bitproximity.com');   // exactamente lo que dejó a Prospección sin conexión
  ok(c.crm.acao === 'https://crm.bitproximity.com' && c.prospeccion_api.acao === 'https://prospeccion.bitproximity.com' && c.prospeccion_mcp.acao === 'https://prospeccion.bitproximity.com', 'con FRONTEND_ORIGIN solo con el CRM, Prospección B2B sigue conectando (API y MCP): ya no depende de la variable');
  ok(c.ajeno.acao === null && c.extra.acao === null, 'un sitio ajeno o un subdominio no listado NO queda permitido');
  ok(c.ajeno_publico.acao === '*', 'solo el formulario público acepta cualquier sitio (se pega en webs de clientes)');
  c = await corsCheck('https://crm.bitproximity.com,https://otro.bitproximity.com');
  ok(c.extra.acao === 'https://otro.bitproximity.com' && c.prospeccion_api.acao === 'https://prospeccion.bitproximity.com' && c.ajeno.acao === null, 'FRONTEND_ORIGIN AGREGA sitios (lista separada por comas) sin quitar los propios');
  c = await corsCheck(undefined);
  ok(c.ajeno.acao === '*' && buildCorsPolicy(undefined).wildcard === true, 'sin FRONTEND_ORIGIN todo sigue abierto, como antes (y el servidor lo avisa)');
})();

// ── 4) límites de peticiones ────────────────────────────────────────────────────────────────────────
const rlApp = express(); rlApp.use(express.json());
rlApp.post('/api/public/lead-forms/:id/submit', publicFormSubmitLimiter, (req, res) => res.status(201).json({ ok: true }));
rlApp.get('/api/public/b2b/:t', publicReadLimiter, (req, res) => res.json({ ok: true }));
const apiLim = makeApiLimiter(3);
rlApp.get('/api/deals', apiLim, (req, res) => res.json({ ok: true }));
const rlSrv = rlApp.listen(0, async () => {
  const port = rlSrv.address().port; const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await post(port, '/api/public/lead-forms/f/submit', { name: 'x' })).status);
  ok(codes.slice(0, 10).every((c) => c === 201) && codes[10] === 429 && codes[11] === 429, 'el formulario público admite 10 envíos por hora por IP; el 11.º recibe 429');
  const lim = await post(port, '/api/public/lead-forms/f/submit', { name: 'x' });
  ok(lim.json.error === 'Has enviado demasiados formularios. Intenta de nuevo más tarde.', 'con un mensaje claro en español');
  const a = []; for (let i = 0; i < 5; i++) a.push((await get(port, '/api/deals', { Authorization: 'Bearer tokenA' })).status);
  const b = (await get(port, '/api/deals', { Authorization: 'Bearer tokenB' })).status;
  ok(a.join() === '200,200,200,429,429' && b === 200, 'la API limita POR PERSONA (su sesión): quien abusa no bloquea a los demás, aunque compartan IP');
  rlSrv.close();
});

// ── 5) formulario público de captación ──────────────────────────────────────────────────────────────
Object.assign(fake.db, {
  lead_forms: [{ id: 'f1', name: 'Web <b>Bit</b>', active: true, pipeline_id: 'p1', stage_id: 's1', owner_id: null, field_ids: ['cf1'], submissions_count: 0 }],
  team_members: [{ id: 'a1', email: 'admin@bit.test', full_name: 'Admin', role: 'admin', active: true }],
  custom_field_definitions: [{ id: 'cf1', label: 'Qué <i>necesitas</i>' }],
  companies: [{ id: 'c-existente', name: 'Acme' }], contacts: [], deals: [], activities: [], custom_field_values: [],
});
const formApp = express(); formApp.use(express.json());
formApp.use('/api/public/lead-forms', require('../src/routes/publicLeadForms'));
formApp.use('/api/mcp-keys', require('../src/routes/mcpKeys'));
const formSrv = formApp.listen(0, async () => {
  const port = formSrv.address().port; const url = '/api/public/lead-forms/f1/submit';
  const n = () => ({ deals: fake.db.deals.length, contacts: fake.db.contacts.length, companies: fake.db.companies.length });
  let r = await post(port, url, { name: 'Robot', website: 'http://spam.example' });
  ok(r.status === 201 && fake.db.deals.length === 0 && sent.length === 0, 'campo trampa (honeypot) lleno: se responde «ok» pero no se crea nada ni se avisa a nadie');
  r = await post(port, url, { name: '   ' }); ok(r.status === 400 && r.json.error === 'Falta el nombre.', 'sin nombre → 400');
  r = await post(port, url, { name: 12345 }); ok(r.status === 400, 'un nombre que no es texto → 400 (antes explotaba con un 500 o pasaba tal cual)');
  r = await post(port, url, { name: 'Ana', email: 'no-es-correo' }); ok(r.status === 400 && r.json.error === 'El correo no es válido.', 'correo inválido → 400');
  r = await post(port, url, 'null'); ok(r.status === 400, 'cuerpo vacío → 400 (no 500)');
  ok(fake.db.deals.length === 0, 'ninguno de los rechazados creó nada');

  const malo = '<script>alert(1)</script><a href="http://phishing.test">Verifica tu cuenta aquí</a>';
  r = await post(port, url, { name: 'Pedro ' + malo, email: 'pedro@x.com', phone: '+507 6000-0000', company: 'Acme', message: 'Hola ' + malo + 'x'.repeat(5000), custom_answers: { cf1: malo, noexiste: 'x', otro: { a: 1 } } });
  ok(r.status === 201, 'un envío normal (con texto hostil) se acepta');
  await new Promise((res) => setTimeout(res, 150));
  const deal = fake.db.deals[0]; const contact = fake.db.contacts[0]; const nota = fake.db.activities[0];
  ok(contact.first_name === 'Pedro' && contact.first_name.length <= 120 && fake.db.companies.length === 1 && deal.company_id === 'c-existente', 'se enlaza a la empresa existente por nombre (sin crear otra)');
  ok(nota.summary.length === 2000, 'el mensaje se recorta a 2000 caracteres (antes: sin límite)');
  const cfv = fake.db.custom_field_values; ok(cfv.length === 1 && cfv[0].field_id === 'cf1', 'solo se guardan las respuestas de preguntas que pertenecen al formulario');
  const mail = sent[0];
  ok(mail && !/<script|<a href="http:\/\/phishing|<b>Bit<\/b>|<i>necesitas/.test(mail.html) && mail.html.includes('&lt;script&gt;') && mail.html.includes('&lt;a href=&quot;http://phishing.test&quot;&gt;'), 'el correo a los administradores lleva TODO lo del visitante como texto (nombre, mensaje, respuestas, nombre del formulario): ningún enlace falso ni script');
  ok(mail.html.includes('/deals/' + deal.id) && mail.to === 'admin@bit.test' && !/[\r\n]/.test(mail.subject), 'el enlace legítimo al trato sigue; el asunto no admite saltos de línea');
  fake.db.companies.push({ id: 'c-coma', name: 'Acme, Inc.' }); const antes = fake.db.companies.length;
  r = await post(port, url, { name: 'Marta', company: 'acme, inc.' }); await new Promise((res) => setTimeout(res, 50));
  ok(fake.db.companies.length === antes && fake.db.deals[fake.db.deals.length - 1].company_id === 'c-coma', 'una empresa con coma («Acme, Inc.») se reconoce aunque cambien las mayúsculas: no se duplica');
  fake.db.companies.length = 1;
  r = await post(port, url, { name: 'Luis', company: '%' }); await new Promise((res) => setTimeout(res, 50));
  ok(fake.db.companies.length === 2 && fake.db.companies[1].name === '%', 'una empresa llamada «%» NO se enlaza con cualquier empresa existente (el comodín se escapa)');

  // claves MCP: solo administración y operaciones
  fake.db.mcp_api_keys = [];
  for (const [role, esperado] of [['outbound', 403], ['wifi_partner', 403], ['operaciones', 201], ['admin', 201]]) {
    const k = await post(port, '/api/mcp-keys', { label: 'x' }, { 'x-role': role });
    ok(k.status === esperado && (esperado !== 201 || /^bitcrm_mcp_[0-9a-f]{48}$/.test(k.json.key)), `crear una clave MCP con el rol «${role}» → ${esperado}`);
  }
  ok(fake.db.mcp_api_keys.length === 2 && fake.db.mcp_api_keys.every((k) => k.key_hash && k.key_hash.length === 64), 'solo se guardó el HASH de las claves creadas (nunca la clave)');
  formSrv.close();

  // ── 6) herramientas del MCP que borran o reordenan ────────────────────────────────────────────────
  fake.db.deals = [{ id: 'd1', title: 'Trato', status: 'abierto' }];
  fake.db.pipelines = []; fake.db.pipeline_stages = [];
  const { buildServer } = require('../src/mcp/server');
  const tool = (srv, name) => { const t = srv._registeredTools && srv._registeredTools[name]; return t && (t.handler || t.callback); };
  const destructivas = [['bitcrm_delete_deal', { deal_id: 'd1' }], ['bitcrm_bulk_delete_deals_except', { pipeline_name: 'X', keep_deal_ids: [], confirm: true }], ['bitcrm_delete_pipeline_stage', { pipeline_name: 'X', stage_name: 'Y' }], ['bitcrm_create_pipeline_stage', { pipeline_name: 'X', stage_name: 'Y' }], ['bitcrm_rename_pipeline_stage', { pipeline_name: 'X', old_stage_name: 'a', new_stage_name: 'b' }], ['bitcrm_reorder_pipelines', { ordered_pipeline_names: ['X'] }]];
  for (const rol of ['outbound', 'wifi_partner', 'operaciones']) {
    const srv = buildServer({ id: 'u1', role: rol, full_name: 'Test' });
    const resultados = [];
    for (const [name, args] of destructivas) { const fn = tool(srv, name); resultados.push(fn ? await fn(args, {}) : null); }
    ok(resultados.every((x) => x && x.isError && /Solo un admin/.test(x.content[0].text)) && fake.db.deals.length === 1, `con el rol «${rol}», las 6 herramientas que borran o reordenan responden «Solo un admin» y no tocan nada`);
  }
  const adm = buildServer({ id: 'u0', role: 'admin', full_name: 'Admin' });
  const del = await tool(adm, 'bitcrm_delete_deal')({ deal_id: 'd1' }, {});
  ok(!del.isError && fake.db.deals.length === 0, 'un administrador sí puede borrar con el MCP');
  restore();
});
