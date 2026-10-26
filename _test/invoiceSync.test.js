// Ciclo completo de sincronización (Alegra y Stripe simulados): crear, actualizar, respetar lo manual, informar y repetir.
const http = require('http'); const path = require('path');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const { createFakeDb, install } = require('./fakeSupabase');
const fake = createFakeDb({
  invoices: [
    { id: 'e1', external_source: 'alegra:1', external_id: '1', invoice_number: 'BIT1', status: 'pendiente', paid_amount: 0, total: 1000, due_date: '2026-10-01', currency: 'COP' },
    { id: 'e2', external_source: 'alegra:1', external_id: '2', invoice_number: 'BIT2', status: 'pagada', paid_amount: 500, total: 500, due_date: '2026-09-01', currency: 'COP' }, // marcada «pagada» a mano en el CRM
    { id: 'e4', external_source: 'alegra:1', external_id: '4', invoice_number: 'BIT4', status: 'cancelada', paid_amount: 700, total: 700, due_date: '2026-08-01', currency: 'COP' }, // «cerrada» que antes se guardaba como cancelada
    { id: 'e5', external_source: 'alegra:1', external_id: '5', invoice_number: 'BIT5', status: 'pendiente', paid_amount: 0, total: 800, due_date: '2026-08-15', currency: 'COP' },
    { id: 'e6', external_source: 'alegra:1', external_id: '6', invoice_number: 'BIT6', status: 'parcial', paid_amount: 100, total: 300, due_date: '2026-08-20', currency: 'COP' }, // anulada en Alegra pero con un cobro registrado en el CRM
    { id: 's1', external_source: 'stripe', external_id: 'in_1', invoice_number: 'ST-1', status: 'pendiente', paid_amount: 0, total: 84, due_date: '2026-10-29', currency: 'USD' },
  ],
  invoice_payments: [], team_members: [], deals: [], companies: [], exchange_rates: [],
});
const restore = install(fake);
process.env.ALEGRA_EMAIL = 'a@b.c'; process.env.ALEGRA_TOKEN = 't'; process.env.ALEGRA_ACCOUNT_NAME = 'BitProximity LLC'; process.env.STRIPE_SECRET_KEY = 'sk_test';

const sync = require('../src/routes/invoiceSync');
const syncStatus = require('../src/utils/syncStatus');
const { memo, size } = require('../src/utils/memo');

const alg = (id, o) => ({ id, numberTemplate: { fullNumber: `BIT${id}` }, subtotal: o.total, tax: 0, date: '2026-09-01', client: { name: `Cliente ${id}` }, ...o });
const ALEGRA = [
  alg(1, { total: 1000, totalPaid: 400, status: 'open', dueDate: '2026-10-09' }),
  alg(2, { total: 500, totalPaid: 0, status: 'open', dueDate: '2026-09-01' }),
  alg(3, { total: 300, totalPaid: 300, status: 'closed', dueDate: '2026-10-25', date: '2026-10-20', currency: { code: 'USD' } }),
  alg(4, { total: 700, totalPaid: 700, status: 'closed', dueDate: '2026-08-01' }),
  alg(5, { total: 800, totalPaid: 0, status: 'void', dueDate: '2026-08-15' }),
  alg(6, { total: 300, totalPaid: 0, status: 'void', dueDate: '2026-08-20' }),
];
const STRIPE = [{ id: 'in_1', number: 'ST-1', status: 'paid', customer_name: 'Ensaladas', customer_email: 'x@y.z', currency: 'usd', subtotal: 8400, total: 8400, amount_paid: 8400, created: 1792000000, due_date: 1793000000 }];
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('api.alegra.com')) return { ok: true, json: async () => (u.includes('start=0') ? ALEGRA : []) };
  if (u.includes('api.stripe.com')) return { ok: true, json: async () => ({ data: STRIPE, has_more: false }) };
  return { ok: false, json: async () => ({}) };
};
const row = (id) => fake.db.invoices.find((i) => i.id === id);

(async () => {
  // estados de Alegra
  const { alegraStatus } = sync._test;
  ok(alegraStatus({ status: 'closed', total: 100, totalPaid: 100 }) === 'pagada', '«cerrada» y cobrada en Alegra = pagada (antes se guardaba como cancelada)');
  ok(alegraStatus({ status: 'closed', total: 100, totalPaid: 0 }) === 'cancelada' && alegraStatus({ status: 'void', total: 100, totalPaid: 0 }) === 'cancelada', '«cerrada» sin cobro y anulada siguen siendo canceladas');
  ok(alegraStatus({ status: 'open', total: 100, totalPaid: 40 }) === 'parcial' && alegraStatus({ status: 'open', total: 100, totalPaid: 0 }) === 'pendiente', 'abierta: parcial o pendiente según lo cobrado');

  await memo('dashboard:x', 60000, async () => ({ viejo: true }));
  ok(size() === 1, '(preparación) hay una respuesta guardada en la caché de corta vida');

  // ── primera corrida de Alegra ──
  let r = await sync.syncAlegra('u-admin');
  ok(!r.error && r.created === 1 && r.updated === 3 && r.skipped === 2 && r.total_en_alegra === 6, 'Alegra: 1 factura nueva, 3 actualizadas, 2 sin cambios (de 6)');
  ok(row('e1').paid_amount === 400 && row('e1').status === 'parcial' && row('e1').due_date === '2026-10-09', 'BIT1: el cobro de 400 y el nuevo vencimiento llegaron al CRM');
  const pagos = fake.db.invoice_payments;
  ok(pagos.length === 1 && pagos[0].invoice_id === 'e1' && pagos[0].amount === 400 && /Alegra/.test(pagos[0].method) && pagos[0].paid_at, 'el cobro queda como pago en el historial de la factura (para los días de cobro)');
  ok(row('e2').status === 'pagada' && row('e2').paid_amount === 500, 'BIT2: marcada «pagada» a mano en el CRM, abierta en Alegra → NO se pisa');
  ok(!r.discrepancies.some((d) => d.invoice_number === 'BIT2'), '…y NO se informa como diferencia: los cobros se registran a mano en el CRM, es lo normal');
  ok(r.discrepancies.length === 1 && r.discrepancies[0].invoice_number === 'BIT6' && r.discrepancies[0].kind === 'anulada_en_origen_con_cobros_en_crm' && row('e6').status === 'parcial', 'BIT6: anulada en Alegra pero con cobros en el CRM → única diferencia que sí se informa (y no se cancela)');
  ok(row('e4').status === 'pagada', 'BIT4: «cerrada» y cobrada que estaba como cancelada pasa a pagada');
  ok(row('e5').status === 'cancelada', 'BIT5: anulada en Alegra y sin cobros → cancelada');
  const nueva = fake.db.invoices.find((i) => i.external_id === '3' && i.external_source === 'alegra:1');
  ok(nueva && nueva.currency === 'USD' && nueva.status === 'pagada' && nueva.paid_amount === 300 && nueva.invoice_number === 'BIT3', 'la factura nueva respeta la moneda que trae Alegra (USD, no «COP» a ciegas) y su estado');
  ok(size() === 0, 'la caché de corta vida se vació: el Dashboard y las métricas ven el cambio al instante');

  // ── repetir no cambia nada ──
  r = await sync.syncAlegra('u-admin');
  ok(r.created === 0 && r.updated === 0 && r.skipped === 6 && fake.db.invoice_payments.length === 1 && fake.db.invoices.length === 7, 'repetir la corrida no crea ni cambia nada (ni duplica pagos)');
  ok(r.discrepancies.length === 1, 'la diferencia de BIT6 se sigue informando mientras exista');

  // ── Stripe ──
  r = await sync.syncStripe('u-admin');
  ok(r.updated === 1 && row('s1').status === 'pagada' && row('s1').paid_amount === 84 && fake.db.invoice_payments.some((p) => p.invoice_id === 's1' && p.amount === 84), 'Stripe: la factura de USD 84 que se pagó allá aparece cobrada aquí, con su pago');
  r = await sync.syncStripe('u-admin'); ok(r.updated === 0 && r.skipped === 1, 'Stripe repetido: sin cambios');

  // ── estado de la sincronización y programador ──
  const { runAll } = require('../src/utils/invoiceScheduler');
  syncStatus.reset();
  await runAll();
  const st = syncStatus.get();
  ok(st.sources.Alegra && st.sources.Alegra.ok && st.sources.Alegra.skipped === 6 && st.sources.Alegra.discrepancies.length === 1, 'el programador registra el estado de Alegra con sus diferencias');
  ok(st.sources.Stripe && st.sources.Stripe.ok && st.last_run_at, 'y el de Stripe, con la hora de la última corrida');

  // ── ruta de estado ──
  const express = require(path.resolve(__dirname, '../node_modules/express'));
  const app = express(); app.use('/api/invoice-sync', sync);
  const srv = app.listen(0, () => {
    http.get({ port: srv.address().port, path: '/api/invoice-sync/status' }, (res) => {
      let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => {
        const j = JSON.parse(s);
        ok(res.statusCode === 200 && j.sources.Alegra.discrepancies[0].invoice_number === 'BIT6' && j.last_run_at, 'GET /api/invoice-sync/status devuelve cuándo corrió y las diferencias');
        srv.close(); restore();
      });
    });
  });
})();
