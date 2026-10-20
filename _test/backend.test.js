// Prueba end-to-end del backend REAL (rutas, auth, permisos) con Supabase y Apollo/Lusha simulados.
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

/* ---------- Supabase simulado (tablas en memoria) ---------- */
const DB = { mcp_api_keys: [], companies: [], contacts: [], deals: [], tags: [], taggables: [], pipelines: [], audit_log: [], leads: [] };
let seq = 0;
const failOn = { contactFirstName: null };
class Q {
  constructor(t) { this.t = t; this.f = []; this.op = 'select'; this.payload = null; this.one = null; this.rg = null; this.lim = null; this.returning = false; }
  select() { if (this.op !== 'select') this.returning = true; return this; }
  insert(p) { this.op = 'insert'; this.payload = p; return this; }
  update(p) { this.op = 'update'; this.payload = p; return this; }
  upsert(p) { this.op = 'upsert'; this.payload = p; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c, v) { this.f.push((r) => r[c] === v); return this; }
  is(c, v) { this.f.push((r) => (r[c] ?? null) === v); return this; }
  ilike(c, v) { this.f.push((r) => String(r[c] ?? '').toLowerCase() === String(v).toLowerCase()); return this; }
  in(c, arr) { this.f.push((r) => arr.includes(r[c])); return this; }
  order() { return this; }
  range(a, b) { this.rg = [a, b]; return this; }
  limit(n) { this.lim = n; return this; }
  single() { this.one = 'single'; return this; }
  maybeSingle() { this.one = 'maybe'; return this; }
  then(res, rej) { try { res(this.run()); } catch (e) { rej ? rej(e) : res({ data: null, error: { message: e.message } }); } }
  run() {
    const T = DB[this.t]; if (!T) return { data: null, error: { message: 'tabla ' + this.t } };
    const match = (r) => this.f.every((fn) => fn(r));
    let rows;
    if (this.op === 'insert' || this.op === 'upsert') {
      const arr = Array.isArray(this.payload) ? this.payload : [this.payload];
      rows = [];
      for (const p of arr) {
        if (this.t === 'contacts' && failOn.contactFirstName && p.first_name === failOn.contactFirstName) return { data: null, error: { message: 'violación simulada' } };
        if (this.op === 'upsert' && this.t === 'taggables' && T.some((r) => r.tag_id === p.tag_id && r.entity_id === p.entity_id)) continue;
        const row = { id: p.id || `${this.t}_${++seq}`, created_at: new Date().toISOString(), ...p };
        T.push(row); rows.push(row);
      }
    } else if (this.op === 'update') { rows = T.filter(match); rows.forEach((r) => Object.assign(r, this.payload)); }
    else if (this.op === 'delete') { rows = T.filter(match); DB[this.t] = T.filter((r) => !match(r)); }
    else { rows = T.filter(match); if (this.rg) rows = rows.slice(this.rg[0], this.rg[1] + 1); if (this.lim) rows = rows.slice(0, this.lim); }
    if (this.one === 'single') return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: 'sin filas' } };
    if (this.one === 'maybe') return { data: rows[0] || null, error: null };
    if ((this.op === 'insert' || this.op === 'upsert') && !this.returning) return { data: null, error: null };
    return { data: rows, error: null };
  }
}
const fakeSupabase = { from: (t) => new Q(t), auth: { getUser: async () => ({ error: { message: 'no jwt' } }) } };

/* ---------- Apollo/Lusha simulados (reemplazan node-fetch) ---------- */
const extCalls = [];
const fakeFetch = async (url, opts = {}) => {
  const body = opts.body ? (opts.body.startsWith && opts.body.startsWith('{') ? JSON.parse(opts.body) : null) : null;
  extCalls.push({ url, body, headers: opts.headers });
  const J = (o, st = 200) => ({ ok: st < 400, status: st, json: async () => o });
  if (url.includes('apollo.io') && url.includes('api_search')) {
    const people = Array.from({ length: body.per_page }, (_, i) => ({ id: `ap${body.page}_${i}`, first_name: `Nombre${i}`, last_name_obfuscated: `Ap***${i}`, title: body.person_titles[0], organization: { name: i === 0 ? 'Banco Sol' : (i === 1 ? 'Empresa Nueva' : `Co ${i}`) }, country: 'Panama' }));
    people[2] = { id: 'ap_ana', first_name: 'Ana', last_name_obfuscated: 'Ru***', title: 'CEO', organization: { name: 'Banco Sol' }, country: 'Panama' };
    return J({ people, pagination: { page: body.page, per_page: 25, total_entries: 60, total_pages: 3 } });
  }
  if (url.includes('apollo.io') && url.includes('people/match')) {
    const id = new URL(url).searchParams.get('id');
    if (id === 'ap_locked') return J({ person: { first_name: 'Lock', last_name: 'Ed', email: 'email_not_unlocked@domain.com', title: 'CTO' } });
    if (id === 'ap_fail') return J({ message: 'sin créditos' }, 402);
    return J({ person: { first_name: 'Real', last_name: 'Apellido' + id, email: `${id}@empresa.com`, linkedin_url: 'https://linkedin.com/in/' + id, title: 'Gerente' } });
  }
  if (url.includes('lusha.com') && url.includes('contact/search')) {
    return J({ data: Array.from({ length: 25 }, (_, i) => ({ contactId: `lu${i}`, firstName: `Luis${i}`, lastName: 'Perez', jobTitle: 'Director', companyName: `Lu Co ${i}`, location: { country: 'Panama' } })) });
  }
  if (url.includes('lusha.com') && url.includes('search-and-enrich')) {
    return J({ results: [{ emails: [{ email: 'luis@luco.com' }], phones: [{ number: '+507111' }], jobTitle: { title: 'Director' } }] });
  }
  return J({}, 404);
};

/* ---------- inyectar simulados ---------- */
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'node-fetch') return fakeFetch;
  if (/config\/supabase$/.test(request)) return fakeSupabase;
  return origLoad.apply(this, arguments);
};
process.env.APOLLO_API_KEY = 'ak'; process.env.LUSHA_API_KEY = 'lk'; process.env.ANTHROPIC_API_KEY = 'k';
const express = require(ROOT + '/node_modules/express');

const keyFor = (token, member) => DB.mcp_api_keys.push({ id: 'k' + token, key_hash: crypto.createHash('sha256').update(token).digest('hex'), revoked_at: null, team_members: member });
const ADMIN = { id: 'u_admin', email: 'mario@bitproximity.com', role: 'admin', active: true, blocked_pages: [] };
const OUTBOUND = { id: 'u_out', email: 'sofia@bitproximity.com', role: 'outbound', active: true, blocked_pages: [] };
const PARTNER = { id: 'u_par', email: 'jorge@bitwifiapp.com', role: 'wifi_partner', active: true, blocked_pages: [] };
const NODEALS = { id: 'u_nd', email: 'carolina@bitproximity.com', role: 'admin', active: true, blocked_pages: ['deals'] };
keyFor('bitcrm_mcp_admin', ADMIN); keyFor('bitcrm_mcp_out', OUTBOUND); keyFor('bitcrm_mcp_par', PARTNER); keyFor('bitcrm_mcp_nodeals', NODEALS);

const app = express(); app.use(express.json());
app.use('/api/prospecting', require(ROOT + '/src/routes/prospecting'));
app.use('/api/prospeccion-tool', require(ROOT + '/src/routes/prospeccionTool'));

function call(port, method, p, body, tok) {
  return new Promise((resolve) => {
    const q = http.request({ port, path: p, method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) } }, (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) { /* no json */ } resolve({ st: res.statusCode, j }); }); });
    if (body) q.write(JSON.stringify(body)); q.end();
  });
}

const srv = app.listen(0, async () => {
  const port = srv.address().port; const A = 'bitcrm_mcp_admin';
  const C = (m, p, b, t) => call(port, m, p, b, t === undefined ? A : t);

  // ---- seguridad / permisos
  for (const [label, tok] of [['sin key', null], ['outbound', 'bitcrm_mcp_out'], ['socio WiFi', 'bitcrm_mcp_par']]) {
    ok((await C('GET', '/api/prospecting/options', null, tok)).st === (tok ? 403 : 401), `options ${label} → ${tok ? 403 : 401}`);
    ok((await C('POST', '/api/prospecting/search', { provider: 'lusha', department: 'x' }, tok)).st === (tok ? 403 : 401), `search ${label} bloqueado (no puede gastar créditos)`);
    ok((await C('POST', '/api/prospecting/import', { candidates: [{ firstName: 'x' }] }, tok)).st === (tok ? 403 : 401), `import ${label} bloqueado`);
    ok((await C('POST', '/api/prospeccion-tool/search', { prompt: 'x' }, tok)).st === (tok ? 403 : 401), `IA de la herramienta ${label} bloqueada`);
    ok((await C('GET', '/api/prospeccion-tool/leads', null, tok)).st === (tok ? 403 : 401), `leads del equipo ${label} bloqueados`);
  }
  extCalls.length = 0;
  let r = await C('GET', '/api/prospecting/options');
  ok(r.st === 200 && r.j.canReveal && r.j.canCreateDeals && r.j.revealCap === 25, 'options admin: puede revelar y crear tratos');
  r = await C('GET', '/api/prospecting/options', null, 'bitcrm_mcp_nodeals');
  ok(r.j.canReveal === true && r.j.canCreateDeals === false, 'admin con «deals» bloqueado: no ofrece crear tratos');

  // ---- datos base del CRM
  DB.companies.push({ id: 'co_banco', name: 'Banco Sol S.A.', created_at: '2026-01-01' });
  DB.contacts.push({ id: 'ct_ana', first_name: 'Ana', last_name: 'Ruiz', company_id: 'co_banco', email: 'ana@bancosol.com' });
  DB.pipelines.push({ id: 'pl_wifi', name: 'Bit WiFi', pipeline_stages: [{ id: 'st_neg', name: 'Negociación', position: 4 }, { id: 'st_pro', name: 'Prospecto', position: 1 }] });
  DB.deals.push({ id: 'dl_1', title: 'Bit WiFi - Banco Sol', status: 'abierto', company_id: 'co_banco', pipeline_id: 'pl_wifi', pipelines: { name: 'Bit WiFi' }, pipeline_stages: { name: 'Negociación' } });

  // ---- búsqueda Apollo: filtros, paginación y marcas «ya en CRM»
  r = await C('POST', '/api/prospecting/search', { provider: 'apollo', title: 'CEO, Director de Marketing', country: 'Panama', industry: 'retail', company: 'Banco', sizes: ['51,200', 'malo', '201,500'], page: 2 });
  const ap = extCalls.find((c) => c.url.includes('api_search')).body;
  ok(r.st === 200 && r.j.candidates.length === 25, 'Apollo: 25 resultados');
  ok(ap.page === 2 && JSON.stringify(ap.person_titles) === '["CEO","Director de Marketing"]' && ap.person_locations[0] === 'Panama', 'Apollo: página, cargos y país enviados bien');
  ok(ap.q_keywords === 'retail Banco' && JSON.stringify(ap.organization_num_employees_ranges) === '["51,200","201,500"]', 'Apollo: industria+empresa → q_keywords y rangos de tamaño (descarta el inválido)');
  ok(r.j.page === 2 && r.j.hasMore === true && r.j.total === 60, 'paginación: página 2, hay más, total 60');
  const bank = r.j.candidates.find((c) => c.externalId === 'ap_ana');
  ok(bank.crm && bank.crm.companyId === 'co_banco' && bank.crm.contactId === 'ct_ana' && bank.crm.contactHasEmail === true, '«Ya en tu CRM»: empresa y contacto reconocidos aunque el apellido venga ofuscado («Ru***»)');
  ok(bank.crm.deals && bank.crm.deals[0].pipeline === 'Bit WiFi' && bank.crm.deals[0].stage === 'Negociación', 'muestra el trato abierto: Bit WiFi · Negociación');
  const other = r.j.candidates.find((c) => c.companyName === 'Banco Sol' && c.externalId !== 'ap_ana');
  ok(other.crm && other.crm.contactId === null && other.crm.openDeals === 1, 'otra persona de la misma empresa: empresa y trato sí, contacto no');
  ok(!r.j.candidates.find((c) => c.companyName === 'Empresa Nueva').crm, 'empresa nueva: sin marca');
  r = await C('POST', '/api/prospecting/search', { provider: 'apollo', title: '' });
  ok(r.st === 400 && /cargo/.test(r.j.error), 'Apollo sin cargo → mensaje claro');

  // ---- búsqueda Lusha con filtros de empresa
  extCalls.length = 0;
  r = await C('POST', '/api/prospecting/search', { provider: 'lusha', department: 'Marketing', country: 'Panama', company: 'Banco Sol, Cadena X', sizes: ['51,200'], page: 3 });
  const lu = extCalls.find((c) => c.url.includes('contact/search')).body;
  ok(lu.pages.page === 2 && lu.pages.size === 25, 'Lusha: página 3 → índice 2 (base 0)');
  ok(JSON.stringify(lu.filters.companies.include.names) === '["Banco Sol","Cadena X"]' && lu.filters.companies.include.sizes[0].min === 51 && lu.filters.companies.include.sizes[0].max === 200, 'Lusha: empresa y tamaño → filtros de companies');
  ok(r.j.hasMore === true, 'Lusha: hay más (página completa)');
  extCalls.length = 0;
  await C('POST', '/api/prospecting/search', { provider: 'lusha', department: 'Marketing' });
  ok(!extCalls[0].body.filters.companies, 'Lusha sin filtros de empresa: petición idéntica a la de antes');

  // ---- importación básica
  const cand = (i, over = {}) => ({ key: `apollo:c${i}`, source: 'apollo', externalId: `c${i}`, firstName: `Persona${i}`, lastName: `Ap***`, title: 'CEO', companyName: `Cliente ${i} SAS`, country: 'Panama', ...over });
  r = await C('POST', '/api/prospecting/import', { candidates: [cand(1), cand(2), { ...cand(3), firstName: '' }], listName: 'Prospección B2B' });
  ok(r.st === 200 && r.j.imported === 2 && r.j.skipped === 1 && r.j.list_name === 'Prospección B2B', 'importa 2, omite 1 sin nombre');
  ok(DB.tags.length === 1 && DB.taggables.filter((t) => t.tag_id === DB.tags[0].id).length === 2, 'quedan en la Lista «Prospección B2B»');
  ok(DB.companies.some((c) => c.name === 'Cliente 1 SAS') && DB.audit_log.some((a) => a.entity_type === 'contact' && a.changes && a.changes.via === 'prospeccion'), 'crea la empresa y deja auditoría via=prospeccion');
  r = await C('POST', '/api/prospecting/import', { candidates: [cand(1)], listName: 'Prospección B2B' });
  ok(r.j.imported === 0 && r.j.results[0].status === 'existing', 'reimportar al mismo contacto no duplica (status existing)');
  ok(DB.contacts.filter((c) => c.first_name === 'Persona1').length === 1, 'sigue habiendo un solo Persona1');

  // ---- revelar email: permisos, tope y créditos
  extCalls.length = 0;
  const many = Array.from({ length: 27 }, (_, i) => cand(100 + i, { externalId: `r${i}`, companyName: `Revela ${i}` }));
  many[0].externalId = 'ap_locked'; many[1].externalId = 'ap_fail';
  r = await C('POST', '/api/prospecting/import', { candidates: many, listName: 'Reveal', revealEmails: true });
  const matches = extCalls.filter((c) => c.url.includes('people/match')).length;
  ok(matches === 25, `tope de créditos: solo 25 revelados de 27 (llamadas a Apollo: ${matches})`);
  ok(r.j.revealed === 23 && r.j.results[0].revealed === false && r.j.results[1].revealError, 'email «bloqueado» y error de crédito no cuentan como revelados; se informa el error');
  const rv = DB.contacts.find((c) => c.first_name === 'Persona102');
  ok(r.j.results[2].lastName === 'Apellidor2', 'la respuesta devuelve el apellido real para que la herramienta lo guarde');
  ok(rv.email === 'r2@empresa.com' && rv.last_name === 'Apellidor2' && rv.enrichment_source === 'apollo', 'el contacto queda con email real y apellido real (ya no ofuscado)');
  extCalls.length = 0;
  r = await C('POST', '/api/prospecting/import', { candidates: [cand(200)], listName: 'Sin reveal' });
  ok(extCalls.filter((c) => c.url.includes('people/match')).length === 0, 'sin marcar «revelar» NO se gastan créditos');

  // ---- crear tratos
  r = await C('POST', '/api/prospecting/import', { candidates: [cand(300, { companyName: 'Tratos SA' }), cand(301, { companyName: 'Tratos SA' }), cand(302, { companyName: 'Banco Sol', firstName: 'Zoe' })], listName: 'Tratos', createDeal: { pipelineId: 'pl_wifi', title: '{empresa} — Prospección' } });
  ok(r.st === 200 && r.j.dealsCreated === 1 && r.j.dealsSkipped === 2, 'crea 1 trato por empresa: la 2.ª persona de la misma empresa y la empresa que ya tenía trato abierto NO duplican');
  const d = DB.deals.find((x) => x.title === 'Tratos SA — Prospección');
  ok(d && d.stage_id === 'st_pro' && d.status === 'abierto' && d.value === 0 && d.pipeline_id === 'pl_wifi' && d.owner_id === 'u_admin', 'trato en la PRIMERA etapa del embudo (Prospecto), valor 0, dueño = quien importa');
  ok(r.j.pipeline === 'Bit WiFi' && r.j.stage === 'Prospecto', 'respuesta informa embudo y etapa');
  r = await C('POST', '/api/prospecting/import', { candidates: [cand(310)], createDeal: { pipelineId: 'no_existe' } });
  ok(r.st === 400, 'embudo inexistente → 400 sin importar nada');
  r = await C('POST', '/api/prospecting/import', { candidates: [cand(311)], createDeal: { pipelineId: 'pl_wifi' } }, 'bitcrm_mcp_nodeals');
  ok(r.st === 403, 'sin acceso a «deals» no se pueden crear tratos aunque sea admin');
  r = await C('POST', '/api/prospecting/import', { candidates: Array.from({ length: 101 }, (_, i) => cand(i)) });
  ok(r.st === 400, 'más de 100 por importación → 400');

  r = await C('POST', '/api/prospecting/import', { candidates: [null, 'texto', cand(450)], listName: 'Basura' });
  ok(r.st === 200 && r.j.imported === 1, 'elementos inválidos en la lista (null, texto) se ignoran sin tumbar la importación');

  // ---- un fallo no tumba el lote
  failOn.contactFirstName = 'Boom';
  r = await C('POST', '/api/prospecting/import', { candidates: [cand(400, { firstName: 'Boom' }), cand(401)], listName: 'Resiliencia' });
  ok(r.st === 200 && r.j.imported === 1 && r.j.errors === 1 && r.j.results[0].status === 'error' && r.j.results[1].status === 'imported', 'si falla uno, el resto se importa y se informa cuál falló');
  failOn.contactFirstName = null;

  // ---- ruta de la herramienta sigue funcionando para admin
  r = await C('POST', '/api/prospeccion-tool/leads/bulk', { leads: [{ id: 'l1', company: 'X', updatedAt: 1 }] });
  ok(r.st !== 401 && r.st !== 403, 'ruta de la herramienta responde para admin');

  srv.close();
});
