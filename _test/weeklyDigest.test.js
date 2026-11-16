// Resumen semanal: rangos de semana, cálculo en USD y correo.
process.env.SUPABASE_URL = 'http://x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const { weekRanges, computeWeeklyDigest, renderDigestHtml, subjectFor } = require('../src/utils/weeklyDigest');

let r = weekRanges('2026-11-16'); // lunes
ok(r.week.from === '2026-11-09' && r.week.to === '2026-11-15' && r.prev.from === '2026-11-02' && r.prev.to === '2026-11-08', 'lunes: la semana es lunes–domingo anterior, y la previa la de antes');
r = weekRanges('2026-11-19'); // jueves
ok(r.week.from === '2026-11-09' && r.week.to === '2026-11-15', 'a mitad de semana sigue siendo la última semana completa');
r = weekRanges('2027-01-03'); // domingo, cruza año
ok(r.week.from === '2026-12-21' && r.week.to === '2026-12-27', 'domingo y cambio de año');

const d = computeWeeklyDigest({
  today: '2026-11-16',
  rates: [{ currency: 'COP', rate_to_usd: 0.00025 }],
  deals: [
    { id: 1, title: 'Cimento', value: 10000, currency: 'USD', status: 'ganado', closed_at: '2026-11-12T15:00:00Z', created_at: '2026-10-01T00:00:00Z' },
    { id: 2, title: 'Oviedo', value: 4000000, currency: 'COP', status: 'ganado', closed_at: '2026-11-16T03:00:00Z', created_at: '2026-11-10T00:00:00Z' }, // domingo 22:00 en Panamá
    { id: 3, title: 'Viejo', value: 500, currency: 'USD', status: 'ganado', closed_at: '2026-11-05T15:00:00Z', created_at: '2026-09-01T00:00:00Z' },   // semana previa
    { id: 4, title: 'Perdido', value: 900, currency: 'USD', status: 'perdido', closed_at: '2026-11-11T15:00:00Z', created_at: '2026-11-09T15:00:00Z' },
    { id: 5, title: 'Hoy', value: 700, currency: 'USD', status: 'ganado', closed_at: '2026-11-16T15:00:00Z', created_at: '2026-11-16T15:00:00Z' },      // esta semana: no cuenta
  ],
  invoices: [
    { id: 'a', client_name: 'Veris', total: 776, paid_amount: 0, currency: 'USD', status: 'pendiente', issue_date: '2026-11-10', due_date: '2026-11-12' },
    { id: 'b', client_name: 'Oviedo', total: 1000000, paid_amount: 0, currency: 'COP', status: 'pendiente', issue_date: '2026-11-13', due_date: '2026-11-28' },
    { id: 'c', client_name: 'Veris', total: 100, paid_amount: 40, currency: 'USD', status: 'parcial', issue_date: '2026-10-01', due_date: '2026-10-10' },
    { id: 'd', client_name: 'Pagada', total: 300, paid_amount: 300, currency: 'USD', status: 'pagada', issue_date: '2026-11-03', due_date: '2026-11-04' },
  ],
  payments: [
    { amount: 300, paid_at: '2026-11-10T14:00:00Z', invoices: { currency: 'USD' } },
    { amount: 400000, paid_at: '2026-11-14T14:00:00Z', invoices: { currency: 'COP' } },
    { amount: 200, paid_at: '2026-11-04T14:00:00Z', invoices: { currency: 'USD' } },
  ],
  activityHealth: { total_open: 10, total_pending: 7, rows: [{ name: 'Mario <b>', open: 8, none: 6, late: 1, pending: 7 }, { name: 'Ana', open: 2, none: 0, late: 0, pending: 0 }] },
});
ok(d.won.count === 2 && Math.round(d.won.usd) === 11000 && d.won.prev_usd === 500 && d.won.top[0].title === 'Cimento', 'ganado de la semana en USD (COP convertido; el del domingo por la noche cuenta; el de hoy no) y semana previa');
ok(d.lost_count === 1 && d.new_deals.count === 2, 'perdidos y tratos nuevos de la semana');
ok(d.invoiced.count === 2 && Math.round(d.invoiced.usd) === 1026 && d.invoiced.prev_usd === 300, 'facturado de la semana y de la previa');
ok(d.collected.usd === 400 && d.collected.prev_usd === 200, 'cobrado: pagos con fecha en la semana, en USD');
ok(Math.round(d.receivable_usd) === 1086 && d.overdue.count === 2 && d.overdue.usd === 836 && d.overdue.top[0].client === 'Veris' && d.overdue.top[0].invoices === 2 && d.overdue.top[0].max_days === 37, 'por cobrar y vencido hoy, agrupado por cliente con días de atraso');
const html = renderDigestHtml(d, 'Mario Ramos');
ok(html.includes('Hola Mario') && html.includes('USD 11,000') && html.includes('▲') && html.includes('Veris') && html.includes('7 de 10 abiertos'), 'el correo trae saludo, montos, comparación, deudores y actividad');
ok(!html.includes('Mario <b>') && html.includes('Mario &lt;b&gt;') && !html.includes('>Ana<'), 'los nombres van escapados y solo se listan vendedores con pendientes');
ok(subjectFor(d) === 'Resumen semanal · USD 11,000 ganado · USD 400 cobrado · USD 836 vencido', 'asunto del correo');
