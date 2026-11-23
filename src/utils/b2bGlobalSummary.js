// Resumen GLOBAL de Bit Prospect: todas las marcas juntas (Spoonity, Fiweex, Periferia…).
// Cuántas reuniones agendó cada ejecutivo por mes, y en qué marcas, industrias y países.
const { groupSimilarText, normalizeText } = require('./b2bDashboard');

const isMeeting = (r) => !!(r.meeting_date || r.realized_date || ['reunion_agendada', 'reunion_realizada', 'reunion_reactivacion'].includes(r.status));
const isRealized = (r) => !!(r.realized_date || r.status === 'reunion_realizada');
// Mes de la reunión: la fecha programada; si no tiene, la realizada. Sin ninguna → «sin fecha».
const monthOf = (r) => (r.meeting_date || r.realized_date || '').slice(0, 7) || null;
const executiveOf = (r) => (r.executive && r.executive.trim()) || r.team_members?.full_name || 'Sin asignar';

// Lista de meses 'YYYY-MM' entre dos meses, ambos incluidos.
function monthRange(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
    if (out.length > 120) break;
  }
  return out;
}
function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

// Agrupa texto libre parecido (Retail / retail / Retail ) con una etiqueta legible; devuelve top + resto.
function breakdown(values, limit = 12) {
  const groups = groupSimilarText(values);
  const total = values.length || 1;
  const top = groups.slice(0, limit).map((g) => ({ ...g, pct: Math.round((100 * g.count) / total) }));
  const rest = groups.slice(limit).reduce((a, g) => a + g.count, 0);
  if (rest) top.push({ name: 'Otros', count: rest, pct: Math.round((100 * rest) / total) });
  return top;
}

/**
 * @param records  b2b_records con team_members(full_name) y companies(name)
 * @param opts     { from: 'YYYY-MM', to: 'YYYY-MM', executive?: string, team?: [nombres], today: 'YYYY-MM-DD' }
 */
function computeGlobalSummary(records, opts) {
  const thisMonth = opts.today.slice(0, 7);
  const allMeetings = (records || []).filter(isMeeting);
  const datedMonths = allMeetings.map(monthOf).filter(Boolean).sort();
  const to = opts.to || thisMonth;
  const from = opts.from === 'all' ? (datedMonths[0] || to) : (opts.from || shiftMonth(to, -11));
  const months = monthRange(from, to);
  const inPeriod = (r) => { const mo = monthOf(r); return mo ? mo >= from && mo <= to : false; };

  // Unifica el mismo ejecutivo escrito distinto (Sofía / sofia / SOFIA).
  const execLabel = new Map();
  const execKey = (name) => { const k = normalizeText(name); if (!execLabel.has(k)) execLabel.set(k, name); return k; };
  (opts.team || []).forEach((n) => execKey(n));

  const period = allMeetings.filter(inPeriod);
  const undated = allMeetings.filter((r) => !monthOf(r));

  // Matriz ejecutivo × mes.
  const rows = new Map();
  const ensure = (k) => {
    if (!rows.has(k)) rows.set(k, { name: execLabel.get(k), by_month: Object.fromEntries(months.map((mo) => [mo, 0])), total: 0, realized: 0, brands: new Set() });
    return rows.get(k);
  };
  (opts.team || []).forEach((n) => ensure(execKey(n)));
  for (const r of period) {
    const row = ensure(execKey(executiveOf(r)));
    row.by_month[monthOf(r)] += 1; row.total += 1;
    if (isRealized(r)) row.realized += 1;
    row.brands.add(r.companies?.name || 'Sin marca');
  }
  const undatedBy = {};
  for (const r of undated) { const k = execKey(executiveOf(r)); undatedBy[k] = (undatedBy[k] || 0) + 1; ensure(k); }

  const monthTotals = Object.fromEntries(months.map((mo) => [mo, 0]));
  const executives = [...rows.entries()].map(([k, row]) => {
    for (const mo of months) monthTotals[mo] += row.by_month[mo];
    const active = months.filter((mo) => mo <= thisMonth);
    return {
      key: k, name: row.name, total: row.total, realized: row.realized,
      realized_pct: row.total ? Math.round((100 * row.realized) / row.total) : 0,
      avg_per_month: active.length ? Math.round((row.total / active.length) * 10) / 10 : 0,
      best_month: months.reduce((best, mo) => (row.by_month[mo] > (best ? row.by_month[best] : 0) ? mo : best), null),
      brands: row.brands.size,
      undated: undatedBy[k] || 0,
      by_month: row.by_month,
    };
  }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  // Desgloses globales (o de un ejecutivo si se filtra).
  const focusKey = opts.executive ? normalizeText(opts.executive) : null;
  const focus = focusKey ? period.filter((r) => normalizeText(executiveOf(r)) === focusKey) : period;
  const bestMonth = months.reduce((best, mo) => (monthTotals[mo] > (best ? monthTotals[best] : 0) ? mo : best), null);

  return {
    period: { from, to, months },
    totals: {
      meetings: period.length,
      realized: period.filter(isRealized).length,
      this_month: allMeetings.filter((r) => monthOf(r) === thisMonth).length,
      executives_with_meetings: executives.filter((e) => e.total > 0).length,
      best_month: bestMonth ? { month: bestMonth, count: monthTotals[bestMonth] } : null,
      undated: undated.length,
    },
    month_totals: monthTotals,
    executives,
    focus: focusKey ? (execLabel.get(focusKey) || opts.executive) : null,
    by_brand: breakdown(focus.map((r) => r.companies?.name || 'Sin marca'), 15),
    by_industry: breakdown(focus.map((r) => r.industry), 12),
    by_country: breakdown(focus.map((r) => r.country), 12),
    focus_total: focus.length,
  };
}

module.exports = { computeGlobalSummary, monthRange, shiftMonth };
