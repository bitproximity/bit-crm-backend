// Verifica que la lista de empresas arma bien la consulta (filtros, orden y conteos).
const Module = require('module'); const path = require('path'); const http = require('http');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const calls = [];
const rows = [{ id: 'c1', name: 'Alfa', country: 'Perú', industry: 'Retail', contacts: [{ count: 3 }], deals: [{ count: 2 }] }];
function Q() { const q = { ops: [] }; const chain = new Proxy(q, { get: (t, k) => (k === 'then' ? (res) => { calls.push(q.ops); res({ data: rows, count: 1, error: null }); } : (...a) => { q.ops.push([k, ...a]); return chain; }) }); return chain; }
const origLoad = Module._load;
Module._load = function (request) {
  if (/config\/supabase$/.test(request)) return { from: () => Q() };
  if (/middleware\/auth$/.test(request)) return { requireAuth: (req, res, next) => { req.teamMember = { id: 'u1', role: 'admin', blocked_pages: [] }; next(); } };
  return origLoad.apply(this, arguments);
};
const express = require(path.resolve(__dirname, '../node_modules/express'));
const app = express(); app.use('/api/companies', require('../src/routes/companies'));
const srv = app.listen(0, async () => {
  const get = (p) => new Promise((r) => http.get({ port: srv.address().port, path: p }, (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => r(JSON.parse(s))); }));
  const has = (ops, name, ...args) => ops.some((o) => o[0] === name && args.every((a, i) => o[i + 1] === a));
  let r = await get('/api/companies?page=1&limit=60'); let ops = calls.pop();
  ok(r.count === 1 && r.data[0].contacts[0].count === 3, 'devuelve los conteos de contactos y tratos');
  ok(ops.find((o) => o[0] === 'select')[1].includes('contacts(count)') && ops.find((o) => o[0] === 'select')[1].includes('deals(count)'), 'pide contacts(count) y deals(count)');
  ok(has(ops, 'order', 'name') && !has(ops, 'eq', 'country'), 'por defecto A–Z y sin filtros');
  await get('/api/companies?country=Per%C3%BA&industry=Retail&sort=recientes'); ops = calls.pop();
  ok(has(ops, 'eq', 'country', 'Perú') && has(ops, 'eq', 'industry', 'Retail'), 'filtra por país e industria');
  ok(has(ops, 'order', 'created_at'), 'orden «recientes» por fecha de creación');
  await get('/api/companies?country=__sin_especificar__'); ops = calls.pop();
  ok(has(ops, 'is', 'country', null), '«Sin especificar» filtra las que no tienen país');
  srv.close();
});
