// Uso: node perf.js <raiz-del-backend> <etiqueta> [check]
// Levanta el server.js REAL de esa carpeta con una base de datos simulada que cobra LAT ms por
// viaje (así se mide el efecto de menos viajes / menos trabajo repetido, no la velocidad de mi PC).
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const Module = require('module');
const ROOT = path.resolve(process.argv[2]);
const LABEL = process.argv[3] || 'x';
const CHECK = process.argv[4] === 'check';
const LAT = 60;            // ms por viaje a la base (California → Ohio ≈ 55–60 ms)
const GOOGLE_MS = 300;     // ms por cuenta de Google (token + eventos)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

const stats = { dbTrips: 0, authCalls: 0, google: 0 };
/* ---------- base simulada ---------- */
const mkDeals = (n) => Array.from({ length: n }, (_, i) => ({ id: `d${String(i).padStart(4, '0')}`, title: `Bit WiFi - Empresa ${i}`, status: i % 25 === 0 ? 'ganado' : 'abierto', value: 100 + i, currency: i % 3 ? 'USD' : 'COP', pipeline_id: 'p1', stage_id: 's1', owner_id: 'u1', company_id: `c${i}`, updated_at: new Date(2026, 9, 1 + (i % 12)).toISOString(), created_at: '2026-09-01T00:00:00Z', closed_at: i % 25 === 0 ? '2026-10-05T00:00:00Z' : null,
  notes: 'Cliente interesado en WiFi Marketing con captación de datos, campañas por email y SMS y remarketing. '.repeat(1),
  contacts: { first_name: `Nombre${i}`, last_name: `Apellido${i}` }, companies: { name: `Empresa ${i} S.A.S.`, country: 'Colombia' }, pipeline_stages: { name: 'Prospecto', position: 1 }, pipelines: { name: i % 2 ? 'Bit WiFi' : 'Neomedia' } }));
const DB = {
  team_members: [
    { id: 'u1', auth_user_id: 'au1', email: 'mario@bitproximity.com', role: 'admin', active: true, blocked_pages: [], created_at: '2026-01-01' },
    { id: 'u2', auth_user_id: 'au2', email: 'sofia@bitproximity.com', role: 'outbound', active: true, blocked_pages: [], created_at: '2026-01-02' },
    { id: 'u3', auth_user_id: 'au3', email: 'jorge@bitwifiapp.com', role: 'wifi_partner', active: true, blocked_pages: [], created_at: '2026-01-03' },
  ],
  notifications: [{ id: 'n1', recipient_id: 'u1', read: false }, { id: 'n2', recipient_id: 'u1', read: false }, { id: 'n3', recipient_id: 'u1', read: true }],
  exchange_rates: [{ currency: 'COP', rate_to_usd: 0.00025 }, { currency: 'USD', rate_to_usd: 1 }, { currency: 'MXN', rate_to_usd: 0.055 }],
  pipelines: [{ id: 'p1', name: 'Bit WiFi', position: 1, created_at: '1', pipeline_stages: [{ id: 's2', name: 'Contactado', position: 2 }, { id: 's1', name: 'Prospecto', position: 1 }] },
              { id: 'p2', name: 'Neomedia', position: 2, created_at: '2', pipeline_stages: [{ id: 's3', name: 'Lead', position: 1 }] }],
  crm_settings: [{ key: 'deal_card_fields', value: { fields: ['value', 'company'] } }],
  deals: mkDeals(684),
  tasks: [{ id: 't1', status: 'pendiente', due_date: '2026-10-01T00:00:00Z', assignee_id: 'u1' }],
  deal_line_items: [], gmail_connections: [{ id: 1, team_member_id: 'u1', email: 'mario@bitproximity.com', refresh_token: 'r1' }, { id: 2, team_member_id: 'u1', email: 'mario@bitwifiapp.com', refresh_token: 'r2' }],
  mcp_api_keys: [], audit_log: [], tags: [], taggables: [],
};
const AUTH_USERS = { 'jwt-admin': 'au1', 'jwt-sofia': 'au2', 'jwt-partner': 'au3' };
const pick = (r, col) => col.includes('.') ? col.split('.').reduce((o, k) => (o == null ? o : o[k]), r) : r[col];
class Q {
  constructor(t) { this.t = t; this.f = []; this.op = 'select'; this.payload = null; this.one = null; this.rg = null; this.lim = null; this.count = null; this.head = false; this.ret = false; }
  select(c, o) { if (this.op !== 'select') this.ret = true; if (o && o.count) this.count = o.count; if (o && o.head) this.head = true; return this; }
  insert(p) { this.op = 'insert'; this.payload = p; return this; } update(p) { this.op = 'update'; this.payload = p; return this; }
  upsert(p) { this.op = 'upsert'; this.payload = p; return this; } delete() { this.op = 'delete'; return this; }
  eq(c, v) { this.f.push((r) => pick(r, c) === v); return this; } neq(c, v) { this.f.push((r) => pick(r, c) !== v); return this; }
  is(c, v) { this.f.push((r) => (pick(r, c) ?? null) === v); return this; } in(c, a) { this.f.push((r) => a.includes(pick(r, c))); return this; }
  gte(c, v) { this.f.push((r) => String(pick(r, c) ?? '') >= String(v)); return this; } lt(c, v) { this.f.push((r) => String(pick(r, c) ?? '') < String(v)); return this; }
  ilike(c, v) { this.f.push((r) => String(pick(r, c) ?? '').toLowerCase() === String(v).toLowerCase()); return this; } or() { return this; }
  order() { return this; } range(a, b) { this.rg = [a, b]; return this; } limit(n) { this.lim = n; return this; }
  single() { this.one = 'single'; return this; } maybeSingle() { this.one = 'maybe'; return this; }
  then(res, rej) { stats.dbTrips++; sleep(LAT).then(() => { try { res(this.run()); } catch (e) { rej ? rej(e) : res({ data: null, error: { message: e.message } }); } }); }
  run() {
    const T = DB[this.t]; if (!T) return { data: null, error: { message: 'tabla ' + this.t } };
    const match = (r) => this.f.every((fn) => fn(r));
    let rows;
    if (this.op === 'insert' || this.op === 'upsert') { const arr = Array.isArray(this.payload) ? this.payload : [this.payload]; rows = arr.map((p) => { const row = { id: p.id || `${this.t}_${T.length + 1}`, ...p }; T.push(row); return row; }); }
    else if (this.op === 'update') { rows = T.filter(match); rows.forEach((r) => Object.assign(r, this.payload)); }
    else if (this.op === 'delete') { rows = T.filter(match); DB[this.t] = T.filter((r) => !match(r)); }
    else { rows = T.filter(match); if (this.count) { if (this.head) return { data: null, count: rows.length, error: null }; } if (this.rg) rows = rows.slice(this.rg[0], this.rg[1] + 1); if (this.lim) rows = rows.slice(0, this.lim); }
    rows = rows.map((r) => structuredClone(r));
    if (this.one === 'single') return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: 'sin filas' } };
    if (this.one === 'maybe') return { data: rows[0] || null, error: null };
    if ((this.op === 'insert' || this.op === 'upsert') && !this.ret) return { data: null, error: null };
    return { data: rows, count: this.count ? rows.length : undefined, error: null };
  }
}
const fakeSupabase = { from: (t) => new Q(t),
  auth: { getUser: async (token) => { stats.authCalls++; stats.dbTrips++; await sleep(LAT); const id = AUTH_USERS[token]; return id ? { data: { user: { id } }, error: null } : { data: null, error: { message: 'jwt' } }; } } };
const googleStub = { google: { auth: { OAuth2: class { setCredentials() { } } }, calendar: () => ({ events: { list: async () => { stats.google++; await sleep(GOOGLE_MS); return { data: { items: [{ id: 'e' + stats.google, summary: 'Reunión', start: { dateTime: '2026-10-14T10:00:00Z' }, end: { dateTime: '2026-10-14T11:00:00Z' } }] } }; } } }) } };

const origLoad = Module._load;
Module._load = function (request, parent) {
  if (/config\/supabase$/.test(request)) return fakeSupabase;
  if (request === 'googleapis') return new Proxy(googleStub, { get: (t, k) => (k in t ? t[k] : undefined) });
  return origLoad.apply(this, arguments);
};
process.env.PORT = '45' + (10 + Math.floor(Math.random() * 80)); process.env.SUPABASE_URL = 'http://x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
process.env.FRONTEND_ORIGIN = 'https://crm.bitproximity.com'; process.env.GOOGLE_CLIENT_ID = 'x'; process.env.GOOGLE_CLIENT_SECRET = 'x'; process.env.GOOGLE_REDIRECT_URI = 'http://x';
const logOrig = console.log; console.log = () => { }; // silencia el arranque del servidor
require(ROOT + '/src/server.js'); console.log = logOrig;
const PORT = +process.env.PORT;

const call = (method, p, token, body, enc) => new Promise((resolve) => {
  const t0 = Date.now(); const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(enc ? { 'Accept-Encoding': enc } : { 'Accept-Encoding': 'identity' }) };
  const rq = http.request({ port: PORT, path: p, method, headers }, (res) => { const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { const raw = Buffer.concat(ch); let txt = raw; if (res.headers['content-encoding'] === 'gzip') txt = zlib.gunzipSync(raw); let j = null; try { j = JSON.parse(txt.toString()); } catch (e) { /* no json */ } resolve({ st: res.statusCode, j, ms: Date.now() - t0, bytes: raw.length, enc: res.headers['content-encoding'] || null }); }); });
  if (body) rq.write(JSON.stringify(body)); rq.end();
});
const burst = async (paths, token) => { const t0 = Date.now(); const rs = await Promise.all(paths.map((p) => call('GET', p, token))); return { ms: Date.now() - t0, rs }; };
const snap = () => ({ ...stats }); const diff = (a, b) => ({ dbTrips: b.dbTrips - a.dbTrips, authCalls: b.authCalls - a.authCalls, google: b.google - a.google });

setTimeout(async () => {
  if (process.argv[4] === 'dump') { const d = await call('GET', '/api/dashboard', 'jwt-admin'); require('fs').writeFileSync(process.argv[5], JSON.stringify(d.j, null, 1)); process.exit(0); }
  const out = { etiqueta: LABEL };
  const SCREEN = ['/api/notifications/unread-count', '/api/exchange-rates', '/api/pipelines', '/api/settings/deal_card_fields', '/api/deals?status=abierto'];

  // S1: abrir una pantalla (5 peticiones simultáneas con la misma sesión), en frío y luego otra pantalla 2 s después
  let a = snap(); let r = await burst(SCREEN, 'jwt-admin'); out.S1_pantalla_fria = { ms_hasta_ultima: r.ms, ...diff(a, snap()) };
  await sleep(2000);
  a = snap(); r = await burst(SCREEN, 'jwt-admin'); out.S1_pantalla_siguiente = { ms_hasta_ultima: r.ms, ...diff(a, snap()) };
  const lightMs = r.rs.slice(0, 4).map((x) => x.ms); out.S1_pantalla_siguiente.ms_endpoints_ligeros = lightMs;

  // S2: Dashboard pedido 3 veces a la vez (lo que hace hoy el navegador al cargar)
  await sleep(500); a = snap(); r = await burst(['/api/dashboard', '/api/dashboard', '/api/dashboard'], 'jwt-admin'); out.S2_dashboard_x3 = { ms_hasta_ultima: r.ms, ...diff(a, snap()) };
  a = snap(); r = await burst(['/api/dashboard'], 'jwt-admin'); out.S2_dashboard_repetido = { ms: r.ms, ...diff(a, snap()) };

  // S3: calendario (2 cuentas de Google): primera vez y segunda
  a = snap(); r = await burst(['/api/gmail/calendar/events?days=7'], 'jwt-admin'); out.S3_calendario_1 = { ms: r.ms, ...diff(a, snap()) };
  a = snap(); r = await burst(['/api/gmail/calendar/events?days=7'], 'jwt-admin'); out.S3_calendario_2 = { ms: r.ms, ...diff(a, snap()) };

  // S4: peso de la lista de tratos
  const plain = await call('GET', '/api/deals?status=abierto', 'jwt-admin'); const gz = await call('GET', '/api/deals?status=abierto', 'jwt-admin', null, 'gzip');
  out.S4_lista_tratos_KB = { sin_comprimir: +(plain.bytes / 1024).toFixed(1), con_gzip: +(gz.bytes / 1024).toFixed(1), codificacion: gz.enc };
  console.log(JSON.stringify(out, null, 1));

  if (CHECK) {
    console.log('--- correccion');
    ok(gz.enc === 'gzip' && gz.j && gz.j.length === plain.j.length, 'gzip: el cliente recibe exactamente los mismos datos (' + plain.j.length + ' tratos)');
    const small = await call('GET', '/health', null, null, 'gzip'); ok(small.enc === null, 'respuestas pequeñas no se comprimen');
    // C1 escritura vacía la caché
    let rates = await call('GET', '/api/exchange-rates', 'jwt-admin'); ok(rates.j.find((x) => x.currency === 'COP').rate_to_usd === 0.00025, 'tasas leídas');
    const pr = await call('PATCH', '/api/exchange-rates/COP', 'jwt-admin', { rate_to_usd: 0.0003 }); ok(pr.st === 200, 'admin actualiza la tasa');
    rates = await call('GET', '/api/exchange-rates', 'jwt-admin'); ok(rates.j.find((x) => x.currency === 'COP').rate_to_usd === 0.0003, 'tras escribir, la siguiente lectura ve el dato NUEVO (caché vaciada)');
    // C2 filtro por rol con caché compartida
    const pp = await call('GET', '/api/pipelines', 'jwt-partner'); const pa = await call('GET', '/api/pipelines', 'jwt-admin');
    ok(pp.j.length === 1 && pp.j[0].name === 'Bit WiFi' && pa.j.length === 2, 'socio WiFi ve solo Bit WiFi y el admin ve ambos (la caché no mezcla roles)');
    ok(pa.j[0].pipeline_stages.map((s) => s.position).join() === '1,2', 'etapas ordenadas');
    // C3 desactivar usuario aplica al instante
    const s1 = await call('GET', '/api/notifications/unread-count', 'jwt-sofia'); ok(s1.st === 200, 'usuario activo entra');
    DB.team_members.find((m) => m.id === 'u2').active = false;
    const s2 = await call('GET', '/api/notifications/unread-count', 'jwt-sofia'); ok(s2.st === 200, 'sin pasar por el backend, el cambio tarda como mucho el TTL (esperado)');
    await call('PATCH', '/api/team/u2', 'jwt-admin', { active: false });
    const s3 = await call('GET', '/api/notifications/unread-count', 'jwt-sofia'); ok(s3.st === 403 && /desactivado/.test(s3.j.error), 'al desactivar a alguien por el CRM, su acceso se corta de inmediato (403)');
    // C4 token inválido y sin token
    const bad = await call('GET', '/api/exchange-rates', 'basura'); ok(bad.st === 401, 'token inválido → 401'); const none = await call('GET', '/api/exchange-rates', null); ok(none.st === 401, 'sin token → 401');
    // C5 contador de notificaciones refleja un cambio propio
    const c1 = await call('GET', '/api/notifications/unread-count', 'jwt-admin'); DB.notifications.push({ id: 'n9', recipient_id: 'u1', read: false });
    await call('POST', '/api/tasks', 'jwt-admin', { title: 'x' }); const c2 = await call('GET', '/api/notifications/unread-count', 'jwt-admin'); ok(c2.j.count === c1.j.count + 1, 'tras cualquier escritura el contador se recalcula');
    // C6 dashboard: mismos números que el original
    const d = await call('GET', '/api/dashboard', 'jwt-admin'); ok(d.j.open_deals === 656 && d.j.open_pipeline_value_usd > 0, 'dashboard: 656 tratos abiertos (684 - 28 ganados) y valor calculado (' + d.j.open_deals + ', $' + d.j.open_pipeline_value_usd + ')');
    // C8 el navegador puede recordar el preflight CORS 2 horas
    const pre = await new Promise((resolve) => { const q = http.request({ port: PORT, path: '/api/dashboard', method: 'OPTIONS', headers: { Origin: 'https://crm.bitproximity.com', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization,content-type' } }, (res) => { res.resume(); res.on('end', () => resolve(res.headers)); }); q.end(); });
    ok(pre['access-control-max-age'] === '7200' && /authorization/i.test(pre['access-control-allow-headers'] || ''), 'preflight CORS: el navegador lo recuerda 2 horas (max-age 7200) y admite Authorization');
    // C7 calendario sin Google conectado
    DB.gmail_connections.length = 0; const nog = await call('GET', '/api/gmail/calendar/events?days=3', 'jwt-admin'); ok(nog.st === 400 && /conectado/.test(nog.j.error), 'sin cuenta de Google: 400 con el mismo mensaje de siempre (y no se recuerda el error)');
  }
  process.exit(process.exitCode || 0);
}, 700);
