// Uso: node sync.js <raiz-backend> <etiqueta>
// Ejecuta un ciclo REAL de syncStripe / syncAlegra / syncFacturermovil contra una base simulada
// (facturas ya existentes + algunas nuevas) y cuenta cuántas consultas hace a la base.
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(process.argv[2]);
const LABEL = process.argv[3] || 'x';
const EXISTING = 600, NEW = 5, PER_VIEJA_MS = 60; // ms por viaje en producción (solo para proyectar)
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

const stats = { trips: 0, selects: 0, inserts: 0, updates: 0, bulkReads: 0 };
const DB = { invoices: [], audit_log: [] };
for (const [src, prefix] of [['stripe', 'in_'], ['alegra:1', ''], ['alegra:2', ''], ['facturero_movil:1', '']]) {
  // Filas como las deja el sincronizador (iguales a lo que trae el origen): así «sin cambios» es de verdad sin cambios.
  const stored = src === 'stripe' ? { status: 'pendiente', paid_amount: 0, total: 11, due_date: '2026-10-30', currency: 'USD' }
    : /^alegra:/.test(src) ? { status: 'pendiente', paid_amount: 0, total: 11, due_date: '2026-10-30', currency: 'COP' } : {};
  for (let i = 0; i < EXISTING; i++) DB.invoices.push({ id: `${src}-${i}`, external_source: src, external_id: `${prefix}${i}`, ...stored });
}
class Q {
  constructor(t) { this.t = t; this.f = []; this.op = 'select'; this.cols = ''; this.one = null; this.rg = null; this.payload = null; }
  select(c) { if (this.op === 'insert') this.ret = true; this.cols = c || '*'; return this; }
  insert(p) { this.op = 'insert'; this.payload = p; return this; }
  update(p) { this.op = 'update'; this.payload = p; return this; }
  eq(c, v) { this.f.push((r) => r[c] === v); return this; }
  order() { return this; } range(a, b) { this.rg = [a, b]; return this; }
  single() { this.one = 'single'; return this; } maybeSingle() { this.one = 'maybe'; return this; }
  then(res) {
    stats.trips++;
    let out;
    if (this.op === 'update') { if (this.t === 'invoices') stats.updates++; (DB[this.t] || []).filter((r) => this.f.every((fn) => fn(r))).forEach((r) => Object.assign(r, this.payload)); out = { data: null, error: null }; }
    else if (this.op === 'insert') { if (this.t === 'invoices') stats.inserts++; const row = { id: `new-${stats.trips}`, ...this.payload }; (DB[this.t] = DB[this.t] || []).push(row); out = { data: row, error: null }; }
    else {
      let rows = (DB[this.t] || []).filter((r) => this.f.every((fn) => fn(r)));
      if (this.rg) { stats.bulkReads++; rows = rows.slice(this.rg[0], this.rg[1] + 1); } else stats.selects++;
      rows = rows.map((r) => ({ ...r }));
      out = this.one === 'maybe' || this.one === 'single' ? { data: rows[0] || null, error: null } : { data: rows, error: null };
    }
    setTimeout(() => res(out), 0);
  }
}
const fakeSupabase = { from: (t) => new Q(t) };
const origLoad = Module._load;
Module._load = function (request) { if (/config\/supabase$/.test(request)) return fakeSupabase; return origLoad.apply(this, arguments); };

// APIs externas simuladas
const ALEGRA_NEW_NUMBERS = ['B2087', 'b2100', 'AB2001', 'F-2050', '2B-77'];
const mkAlegra = () => Array.from({ length: EXISTING + NEW }, (_, i) => ({ id: i, numberTemplate: { fullNumber: i >= EXISTING ? ALEGRA_NEW_NUMBERS[i - EXISTING] : `F-${i}` }, subtotal: 10, tax: 1, total: 11, totalPaid: 0, status: 'open', date: '2026-10-01', dueDate: '2026-10-30', client: { name: 'Cliente ' + i } }));
const mkStripe = () => Array.from({ length: EXISTING + NEW }, (_, i) => ({ id: `in_${i}`, number: `S-${i}`, currency: 'usd', subtotal: 1000, total: 1100, amount_paid: 0, status: 'open', created: 1790000000, customer_name: 'C' + i, customer_email: 'c@x.com' }));
const mkFm = () => Array.from({ length: EXISTING + NEW }, (_, i) => ({ id: i, codigoSri: '01', fechaEmision: '2026-10-01T00:00:00-05:00', numeroDocumento: `001-${i}`, valor: 10, estado: 'AUTORIZADO', razonSocial: 'R' + i }));
const J = (o, st = 200) => ({ ok: st < 400, status: st, json: async () => o });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('api.alegra.com')) { const start = +new URL(u).searchParams.get('start'); const all = mkAlegra(); return J(all.slice(start, start + 30)); }
  if (u.includes('api.stripe.com')) { const all = mkStripe(); return J({ data: all, has_more: false }); }
  if (u.includes('login_check')) return J({ token: 'tok' });
  if (u.includes('/api/documentos')) { const off = +new URL(u).searchParams.get('offset'); return J(mkFm().slice(off, off + 100)); }
  return J({}, 404);
};
Object.assign(process.env, { SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: 'x', STRIPE_SECRET_KEY: 'sk', ALEGRA_EMAIL: 'a@b.c', ALEGRA_TOKEN: 't', ALEGRA_ACCOUNT_NAME: 'BIT', ALEGRA_EMAIL_2: 'a2@b.c', ALEGRA_TOKEN_2: 't2', ALEGRA_ACCOUNT_NAME_2: 'Personal', FACTUREROMOVIL_USERNAME_1: 'u', FACTUREROMOVIL_PASSWORD_1: 'p', FACTUREROMOVIL_NAME_1: 'Neomedia' });

(async () => {
  const { syncStripe, syncAlegra } = require(ROOT + '/src/routes/invoiceSync');
  const { syncFacturermovil } = require(ROOT + '/src/routes/facturermovilSync');
  const out = { etiqueta: LABEL };
  for (const [name, fn, extra] of [['Stripe', syncStripe], ['Alegra (2 cuentas)', syncAlegra], ['Facturero Móvil', syncFacturermovil]]) {
    const before = { ...stats }; const t0 = Date.now(); const r = await fn('actor-1'); const d = (k) => stats[k] - before[k];
    out[name] = { consultas_a_la_base: d('trips'), una_por_factura: d('selects'), lecturas_en_bloque: d('bulkReads'), inserts: d('inserts'), nuevas: r.created, ya_existian: r.skipped, proyeccion_segundos_a_60ms: +(d('trips') * PER_VIEJA_MS / 1000).toFixed(1) };
    if (r.error) out[name].error = r.error;
  }
  const total = stats.trips; out.TOTAL_consultas_por_ciclo = total; out.TOTAL_proyeccion_seg_a_60ms_por_viaje = +(total * PER_VIEJA_MS / 1000).toFixed(1);
  console.log(JSON.stringify(out, null, 1));
  if (process.argv[4] === 'check') {
    console.log('--- correccion');
    ok(out.Stripe.nuevas === NEW && out.Stripe.ya_existian === EXISTING, `Stripe: ${NEW} nuevas y ${EXISTING} ya existían`);
    ok(out['Alegra (2 cuentas)'].nuevas === NEW * 2 && out['Alegra (2 cuentas)'].ya_existian === EXISTING * 2, `Alegra: ${NEW * 2} nuevas y ${EXISTING * 2} ya existían (2 cuentas)`);
    ok(out['Facturero Móvil'].nuevas === NEW && out['Facturero Móvil'].ya_existian === EXISTING, `Facturero Móvil: ${NEW} nuevas y ${EXISTING} ya existían`);
    ok(stats.updates === 0, 'ninguna factura sin cambios genera una escritura (solo se escribe lo que cambió en el origen)');
    ok(DB.invoices.length === 4 * EXISTING + 4 * NEW, `la tabla quedó con ${DB.invoices.length} facturas (2.400 existentes + 20 nuevas)`);
    const keys = DB.invoices.map((r) => r.external_source + '|' + r.external_id); ok(new Set(keys).size === keys.length, 'ninguna factura repetida (fuente + id)');
    const alegraRows = DB.invoices.filter((r) => /^alegra:/.test(r.external_source) && r.invoice_number);
    const by = (n) => alegraRows.filter((r) => r.invoice_number === n);
    ok(by('B2087').length === 2 && by('B2087').every((r) => r.source_account === 'Mario Colombia'), 'B2087 (en las 2 cuentas de Alegra) → origen «Mario Colombia»');
    ok(by('b2100').every((r) => r.source_account === 'Mario Colombia'), 'b2100 (minúscula) → «Mario Colombia»');
    ok(by('AB2001').every((r) => r.source_account !== 'Mario Colombia'), 'AB2001 (B2 en medio, no al inicio) NO cambia');
    ok(by('F-2050').every((r) => r.source_account !== 'Mario Colombia'), 'F-2050 NO cambia');
    ok(by('2B-77').every((r) => r.source_account !== 'Mario Colombia'), '2B-77 (empieza con 2, no con B2) NO cambia');
    ok(by('B2087').every((r) => /Importado de Alegra \(Mario Colombia\)/.test(r.notes)), 'la nota también dice Mario Colombia');
    const stripeOrFm = DB.invoices.filter((r) => !/^alegra:/.test(r.external_source) && r.source_account === 'Mario Colombia'); ok(stripeOrFm.length === 0, 'Stripe y Facturero Móvil no se tocan');
    const before = stats.inserts; const r2 = await syncAlegra('actor-1'); ok(stats.inserts === before && r2.created === 0, 'una segunda corrida seguida no inserta nada');
  }
  process.exit(process.exitCode || 0);
})();
