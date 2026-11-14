// Recordatorio de factura vencida (texto) y aviso diario (sin base real: simulador mínimo)
process.env.SUPABASE_URL = 'http://x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m); } };
const { reminderText } = require('../src/utils/overdueReminder');
const inv = { invoice_number: '8164BB5A-0010', total: 312, paid_amount: 0, currency: 'USD', due_date: '2026-11-01', client_name: 'FASHION FITNESS PERU S.A.C.' };
const es = reminderText(inv, 'es', 1);
ok(es.subject.includes('8164BB5A-0010') && es.body.includes('USD 312,00') && es.body.includes('hace 1 día)') && es.body.includes('FASHION FITNESS'), 'recordatorio en español: número, saldo, días de atraso y cliente');
const en = reminderText({ ...inv, paid_amount: 112 }, 'en', 5);
ok(en.subject.startsWith('Payment reminder') && en.body.includes('USD 200,00') && en.body.includes('5 days ago'), 'en inglés y con el saldo pendiente (no el total) cuando hay pago parcial');
const { withDefaultDueDate } = require('../src/utils/invoiceTerms');
ok(withDefaultDueDate({ source_account: 'Bithub SRL', issue_date: '2026-03-02', due_date: null }).due_date === '2026-04-01', 'Bithub sin vencimiento: emisión + 30 días');
ok(withDefaultDueDate({ source_account: 'Bithub SRL', issue_date: '2026-12-15' }).due_date === '2027-01-14', 'cruza de año bien');
ok(withDefaultDueDate({ source_account: 'Bithub SRL', issue_date: '2026-03-02', due_date: '2026-03-10' }).due_date === '2026-03-10', 'si ya trae vencimiento, se respeta');
ok(withDefaultDueDate({ source_account: 'BitProximity LLC', issue_date: '2026-03-02', due_date: null }).due_date === null, 'otra empresa sin plazo definido: no se toca');
const { buildRevenueBreakdown } = require('../src/utils/revenueBreakdown');
{
  const conv = { toUsd: (v, c) => (c === 'COP' ? v * 0.00025 : v) };
  const rb = buildRevenueBreakdown({
    invoices: [
      { id: 'a', status: 'pagada', paid_amount: 100, currency: 'USD', source_account: 'Diana Sánchez' },
      { id: 'b', status: 'pagada', paid_amount: 400000, currency: 'COP', source_account: 'Mario Colombia' },
      { id: 'c', status: 'pagada', paid_amount: 50, currency: 'USD', source_account: 'BitProximity LLC', company_id: 'k' },
      { id: 'd', status: 'cancelada', paid_amount: 999, currency: 'USD', source_account: 'X' },
    ],
    lines: [
      { invoice_id: 'a', description: 'Servicio WiFi mensual', quantity: 1, unit_price: 75 },
      { invoice_id: 'a', description: 'Licencia Bit Music', quantity: 1, unit_price: 25 },
      { invoice_id: 'b', description: 'Radio digital', quantity: 1, unit_price: 400000 },
    ],
    products: [{ id: 'p1', name: 'Bit Music' }],
    companiesById: new Map([['k', { id: 'k', country: 'Guatemala' }]]),
    converter: conv,
  });
  const p = Object.fromEntries(rb.by_product.map((r) => [r.name, r.usd]));
  const c = Object.fromEntries(rb.by_country.map((r) => [r.name, r.usd]));
  ok(rb.total_usd === 250 && p['Bit WiFi'] === 75 && p['Bit Music'] === 125 && p['Sin detalle de productos'] === 50, 'cobrado por producto: reparte la factura entre sus líneas y separa lo que no tiene detalle');
  ok(c.Ecuador === 100 && c.Colombia === 100 && c.Guatemala === 50 && !('X' in c), 'cobrado por país: empresa vinculada primero, si no la empresa que facturó; anuladas fuera');
  ok(rb.detail_coverage_pct === 80, 'cobertura: % de lo cobrado que tiene detalle de productos');
}
{
  const { productFromText } = require('../src/utils/revenueBreakdown');
  const cat = [{ name: 'Servicio de prospección', key: 'servicio de prospeccion' }];
  ok(productFromText('Servicios profesionales — Servicio de prospección mes de agosto', cat) === 'Bit Prospect', '«Servicio de prospección» del catálogo se agrupa como Bit Prospect');
  ok(productFromText('Fee mensual Social WiFi — Portal Cautivo (42 aps)', []) === 'Bit WiFi' && productFromText('Comisiones', []) === 'Comisiones y servicios profesionales', 'Social WiFi → Bit WiFi; Comisiones → servicios profesionales');
}
console.log(`\n${pass} ok · ${fail} fallan`);
process.exit(fail ? 1 : 0);
