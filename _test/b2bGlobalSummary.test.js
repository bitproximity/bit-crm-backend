// Resumen global de Bit Prospect: todas las marcas juntas, por ejecutivo y mes.
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const { computeGlobalSummary, monthRange } = require('../src/utils/b2bGlobalSummary');

ok(monthRange('2025-11', '2026-02').join() === '2025-11,2025-12,2026-01,2026-02', 'meses entre dos fechas, cruzando el año');

const R = (exec, brand, date, extra = {}) => ({ executive: exec, companies: { name: brand }, meeting_date: date, status: 'reunion_agendada', ...extra });
const records = [
  R('Sofía Pérez', 'Spoonity', '2026-10-03', { industry: 'Restaurantes', country: 'Colombia' }),
  R('sofia perez', 'Fiweex', '2026-10-20', { industry: 'restaurantes', country: 'colombia' }),
  R('Sofía Pérez', 'Periferia', '2026-11-05', { industry: 'Retail', country: 'México', realized_date: '2026-11-06' }),
  R('Martina', 'Spoonity', '2026-11-10', { industry: 'Hoteles', country: 'Panamá' }),
  R('Martina', 'Fiweex', '2025-05-01', { industry: 'Hoteles', country: 'Panamá' }), // fuera de los últimos 12 meses
  { executive: 'Martina', companies: { name: 'Spoonity' }, status: 'reunion_agendada' }, // agendada sin fecha
  { executive: 'Martina', companies: { name: 'Spoonity' }, status: 'contactado', contacted_at: '2026-11-01' }, // no es reunión
  { executive: '', team_members: { full_name: 'Ana Espinel' }, companies: { name: 'Periferia' }, meeting_date: '2026-09-15', industry: 'Retail', country: 'Ecuador' },
];
const g = computeGlobalSummary(records, { today: '2026-11-22', team: ['Sofía Pérez', 'Martina', 'Ana Espinel', 'Mariana'] });
ok(g.period.from === '2025-12' && g.period.to === '2026-11' && g.period.months.length === 12, 'por defecto: los últimos 12 meses hasta el actual');
ok(g.totals.meetings === 5 && g.totals.realized === 1 && g.totals.this_month === 2 && g.totals.undated === 1, 'totales del período: reuniones, realizadas, este mes y agendadas sin fecha');
const sofia = g.executives.find((e) => e.name === 'Sofía Pérez');
ok(sofia && sofia.total === 3 && sofia.by_month['2026-10'] === 2 && sofia.by_month['2026-11'] === 1 && sofia.brands === 3, 'Sofía suma sus reuniones de TODAS las marcas por mes (aunque su nombre esté escrito distinto)');
ok(g.executives[0].name === 'Sofía Pérez' && g.executives.find((e) => e.name === 'Mariana').total === 0, 'ranking por total, y aparece también quien no agendó nada');
ok(g.executives.find((e) => e.name === 'Martina').undated === 1, 'avisa las reuniones agendadas sin fecha de cada ejecutivo');
ok(g.executives.find((e) => e.name === 'Ana Espinel').total === 1, 'sin ejecutivo escrito, cuenta para quien la cargó');
ok(g.month_totals['2026-10'] === 2 && g.totals.best_month.month === '2026-10' || g.totals.best_month.month === '2026-11', 'totales por mes y mejor mes');
ok(g.by_industry[0].name.toLowerCase() === 'restaurantes' && g.by_industry[0].count === 2 && g.by_country.find((c) => /colombia/i.test(c.name)).count === 2, 'industria y país globales, sin separar «Restaurantes» de «restaurantes»');
ok(g.by_brand.find((b) => b.name === 'Spoonity').count === 2 && g.by_brand.find((b) => b.name === 'Periferia').count === 2, 'reparto por marca en el período');

const f = computeGlobalSummary(records, { today: '2026-11-22', executive: 'sofia perez' });
ok(f.focus === 'Sofía Pérez' && f.focus_total === 3 && f.by_country.length === 2, 'filtrar por un ejecutivo: sus marcas, industrias y países');
const all = computeGlobalSummary(records, { today: '2026-11-22', from: 'all' });
ok(all.period.from === '2025-05' && all.totals.meetings === 6, '«Todo»: desde la primera reunión registrada');

const { isExcludedExecutive } = require('../src/utils/bitProspectTeam');
ok(isExcludedExecutive('Martina') && isExcludedExecutive('martina villacreses') && isExcludedExecutive('MARTINA  Villacreses') && !isExcludedExecutive('Mariana') && !isExcludedExecutive('Sofía Pérez') && !isExcludedExecutive(''), 'Martina queda fuera del resumen escrita como sea; Mariana y Sofía no');

// Martina: sin fila, pero sus reuniones siguen sumando a los totales y al reparto por marca.
const h = computeGlobalSummary(records, { today: '2026-11-22', team: ['Sofía Pérez', 'Ana Espinel'], hideExecutive: isExcludedExecutive });
ok(!h.executives.some((e) => /martina/i.test(e.name)), 'Martina no tiene fila en la tabla');
ok(h.totals.meetings === 5 && h.month_totals['2026-11'] === 2 && h.by_brand.find((b) => b.name === 'Spoonity').count === 2, 'pero sus reuniones siguen en los totales del mes y en el reparto por marca');
ok(h.totals.undated === 1 && h.executives.every((e) => e.undated === 0), 'su reunión sin fecha cuenta en el aviso general, no en una fila');
const { isExcludedFromBitProspect } = require('../src/utils/bitProspectTeam');
ok(isExcludedFromBitProspect('Jorge Iván') && isExcludedFromBitProspect('jorge ivan') && isExcludedExecutive('Jorge Iván'), 'Jorge Iván fuera de Bit Prospect (equipo, metas y resumen)');
