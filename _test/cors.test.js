// CORS: la API del CRM solo para el CRM; los formularios públicos, desde cualquier sitio (se pegan en webs de clientes).
const http = require('http'); const path = require('path');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const express = require(path.resolve(__dirname, '../node_modules/express'));
const { buildCorsPolicy } = require('../src/middleware/corsPolicy');

const start = (envValue) => new Promise((resolve) => {
  const app = express();
  app.use(buildCorsPolicy(envValue).handler);
  app.get('/api/team', (req, res) => res.json({ ok: 1 }));
  app.post('/api/public/lead-forms/:id/submit', (req, res) => res.status(201).json({ ok: true }));
  app.get('/api/public/b2b/:t', (req, res) => res.json({ ok: 1 }));
  const srv = app.listen(0, () => resolve({ srv, port: srv.address().port }));
});
const call = (port, method, p, origin, extra = {}) => new Promise((resolve) => {
  const req = http.request({ port, method, path: p, headers: { ...(origin ? { Origin: origin } : {}), ...extra } }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, acao: res.headers['access-control-allow-origin'] })); });
  req.end();
});

(async () => {
  // Con FRONTEND_ORIGIN definido: la API solo responde al CRM…
  let { srv, port } = await start('https://crm.bitproximity.com');
  let r = await call(port, 'GET', '/api/team', 'https://crm.bitproximity.com'); ok(r.acao === 'https://crm.bitproximity.com', 'la API acepta al CRM (origen permitido)');
  r = await call(port, 'GET', '/api/team', 'https://sitio-malo.com'); ok(!r.acao, 'la API NO acepta a otro sitio web (el navegador bloquea la respuesta)');
  r = await call(port, 'OPTIONS', '/api/team', 'https://sitio-malo.com', { 'Access-Control-Request-Method': 'GET' }); ok(!r.acao, 'ni siquiera la consulta previa (preflight) de otro sitio');
  // …pero lo público sigue abierto, para los formularios incrustados en webs de clientes
  r = await call(port, 'OPTIONS', '/api/public/lead-forms/abc/submit', 'https://web-del-cliente.com', { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }); ok(r.acao === '*', 'el formulario público responde la consulta previa a cualquier sitio');
  r = await call(port, 'POST', '/api/public/lead-forms/abc/submit', 'https://web-del-cliente.com'); ok(r.status === 201 && r.acao === '*', 'y el envío desde la web de un cliente funciona');
  r = await call(port, 'GET', '/api/public/b2b/xyz', 'https://otra-web.com'); ok(r.acao === '*', 'el reporte público compartido también se puede abrir desde cualquier sitio');
  srv.close();
  // Varios orígenes permitidos
  ({ srv, port } = await start('https://crm.bitproximity.com, http://localhost:5173'));
  r = await call(port, 'GET', '/api/team', 'http://localhost:5173'); ok(r.acao === 'http://localhost:5173', 'varios orígenes separados por coma (CRM y desarrollo local)');
  r = await call(port, 'GET', '/api/team', 'https://sitio-malo.com'); ok(!r.acao, '…y los demás siguen bloqueados');
  srv.close();
  // Sin FRONTEND_ORIGIN (hoy): se acepta cualquiera, como antes, y se informa
  const abierta = buildCorsPolicy(undefined); ok(abierta.wildcard === true, 'sin FRONTEND_ORIGIN la política es abierta (y el servidor lo avisa al arrancar)');
  ({ srv, port } = await start(undefined));
  r = await call(port, 'GET', '/api/team', 'https://cualquiera.com'); ok(r.acao === '*', 'sin la variable, cualquier sitio recibe respuesta (comportamiento actual)');
  srv.close();
  ok(buildCorsPolicy('').wildcard === true && buildCorsPolicy(' , ').wildcard === true, 'una variable vacía o solo con comas no deja la API cerrada para todos: se comporta como sin definir');
})();
