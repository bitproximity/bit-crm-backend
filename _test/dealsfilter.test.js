// El filtro product_line de la lista de tratos llega a la consulta (ambas ramas: búsqueda rápida y lista completa).
const Module = require('module'); const path = require('path'); const http = require('http');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const calls = [];
function Q() { const q = { ops: [] }; const chain = new Proxy(q, { get: (t, k) => (k === 'then' ? (res) => { calls.push(q.ops); res({ data: [], count: 0, error: null }); } : (...a) => { q.ops.push([k, ...a]); return chain; }) }); return chain; }
const origLoad = Module._load;
Module._load = function (request) {
  if (/config\/supabase$/.test(request)) return { from: () => Q() };
  if (/middleware\/auth$/.test(request)) return { requireAuth: (req, res, next) => { req.teamMember = { id: 'u1', role: 'admin', blocked_pages: [] }; next(); }, requireRole: () => (req, res, next) => next() };
  if (/middleware\/pagePermissions$/.test(request)) return { requirePage: () => (req, res, next) => next() };
  return origLoad.apply(this, arguments);
};
const express = require(path.resolve(__dirname, '../node_modules/express'));
let router; try { router = require('../src/routes/deals'); } catch (e) { console.log('FAIL no carga deals:', e.message); process.exit(1); }
const app = express(); app.use('/api/deals', router);
const srv = app.listen(0, async () => {
  const get = (p) => new Promise((r) => http.get({ port: srv.address().port, path: p }, (res) => { res.resume(); res.on('end', r); }));
  const has = (ops, name, ...args) => ops.some((o) => o[0] === name && args.every((a, i) => o[i + 1] === a));
  await get('/api/deals?product_line=Email%20Marketing&limit=5'); let ops = calls.find((c) => c.some((o) => o[0] === 'limit'));
  ok(ops && has(ops, 'eq', 'product_line', 'Email Marketing'), 'búsqueda rápida: filtra por product_line');
  calls.length = 0;
  await get('/api/deals?status=ganado&product_line=SMS'); ops = calls.find((c) => has(c, 'eq', 'product_line', 'SMS'));
  ok(!!ops, 'lista completa: filtra por product_line');
  calls.length = 0; await get('/api/deals?status=abierto'); ok(!calls.some((c) => c.some((o) => o[0] === 'eq' && o[1] === 'product_line')), 'sin el parámetro no filtra por producto');
  srv.close();
});
