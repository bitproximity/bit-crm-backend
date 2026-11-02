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
console.log(`\n${pass} ok · ${fail} fallan`);
process.exit(fail ? 1 : 0);
