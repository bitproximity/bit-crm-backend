// Métricas del CEO — todo en USD con las tasas del día.
//
// Une lo que antes estaba repartido (ventas en Métricas, facturación en Facturación, cobranza en ninguna parte):
//   VENTAS     tratos ganados del año y del mes
//   FACTURADO  lo emitido en el año y en el mes
//   COBRANZA   cobrado, por cobrar, vencido, antigüedad de cartera, días promedio de cobro (DSO), morosos
//   LÍDERES    producto, país y embudo que más venden
//   VELOCIDAD  quién se demora más: en cerrar (por embudo, país, producto) y en pagar (por cliente)
// Es una función pura (recibe los datos ya cargados) para poder probarla con ejemplos.
const { buildConverter, round2 } = require('./currency');
const { dateInTz } = require('./businessDate');
const { buildProductInsights, productOfDeal } = require('./productOfDeal');
const { resolveDealCountry } = require('./pipelineCountry');

const dayNum = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const diffDays = (from, to) => Math.round(dayNum(to) - dayNum(from));
const isVoid = (i) => i.status === 'cancelada' && Number(i.paid_amount || 0) === 0;
const isOpen = (i) => i.status !== 'pagada' && i.status !== 'cancelada';
const avg = (arr) => (arr.length ? arr.reduce((n, x) => n + x, 0) / arr.length : 0);

// Agrupa [{key, value}] → [{name, avg_days, deals}] ordenado del más lento al más rápido (mínimo `minN` casos por grupo).
function slowest(items, minN = 2, top = 5) {
  const groups = new Map();
  items.forEach(({ key, days }) => { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(days); });
  return [...groups.entries()]
    .filter(([, d]) => d.length >= minN)
    .map(([name, d]) => ({ name, avg_days: Math.round(avg(d)), deals: d.length }))
    .sort((a, b) => b.avg_days - a.avg_days)
    .slice(0, top);
}

function computeFinance({ invoices = [], payments = [], deals = [], rates = [], today, reconciliation = null }) {
  const conv = buildConverter(rates);
  const year = today.slice(0, 4);
  const month = today.slice(0, 7);
  const oneYearAgo = dateInTz(new Date(new Date(`${today}T12:00:00Z`).getTime() - 365 * 86400000));
  const live = invoices.filter((i) => !isVoid(i));
  const clientOf = (i) => i.client_name || i.companies?.name || 'Sin nombre';

  // ── Facturación y cobranza ──
  let facturadoYtd = 0, cobradoYtd = 0, facturadoMonth = 0, invoicesYtd = 0, porCobrar = 0, vencido = 0, vencidoCount = 0;
  const aging = { al_dia: 0, '1_30': 0, '31_60': 0, '61_90': 0, mas_90: 0 };
  const debtors = new Map();
  for (const i of live) {
    const total = conv.toUsd(i.total, i.currency);
    const paid = conv.toUsd(i.paid_amount, i.currency);
    if (String(i.issue_date || '').startsWith(year)) {
      facturadoYtd += total; cobradoYtd += paid; invoicesYtd += 1;
      if (i.issue_date.startsWith(month)) facturadoMonth += total;
    }
    if (!isOpen(i)) continue;
    const pending = Math.max(total - paid, 0);
    porCobrar += pending;
    if (i.due_date && i.due_date < today) {
      const late = diffDays(i.due_date, today);
      vencido += pending; vencidoCount += 1;
      if (late <= 30) aging['1_30'] += pending; else if (late <= 60) aging['31_60'] += pending; else if (late <= 90) aging['61_90'] += pending; else aging.mas_90 += pending;
      const name = clientOf(i);
      const d = debtors.get(name) || { client: name, overdue_usd: 0, invoices: 0, max_days_late: 0 };
      d.overdue_usd += pending; d.invoices += 1; d.max_days_late = Math.max(d.max_days_late, late);
      debtors.set(name, d);
    } else {
      aging.al_dia += pending;
    }
  }

  // Cobros registrados este mes (por fecha del pago, en la zona del negocio)
  const invById = new Map(invoices.map((i) => [i.id, i]));
  let cobrosMonth = 0;
  const lastPayment = new Map(); // factura → fecha del último pago
  for (const p of payments) {
    const inv = invById.get(p.invoice_id);
    if (!inv) continue;
    const date = dateInTz(p.paid_at);
    if (date.startsWith(month)) cobrosMonth += conv.toUsd(p.amount, inv.currency);
    if (!lastPayment.has(p.invoice_id) || date > lastPayment.get(p.invoice_id)) lastPayment.set(p.invoice_id, date);
  }

  // Días de cobro: de la emisión al último pago, solo facturas ya pagadas del último año con pagos registrados
  const paidDays = [];
  for (const i of live) {
    if (i.status !== 'pagada' || !i.issue_date || i.issue_date < oneYearAgo || !lastPayment.has(i.id)) continue;
    paidDays.push({ i, days: Math.max(0, diffDays(i.issue_date, lastPayment.get(i.id))) });
  }
  const dso = paidDays.length ? Math.round(avg(paidDays.map((p) => p.days))) : null;
  const dsoByAccount = [...paidDays.reduce((m, { i, days }) => {
    const k = i.source_account || 'Sin origen'; if (!m.has(k)) m.set(k, []); m.get(k).push(days); return m;
  }, new Map()).entries()].map(([name, d]) => ({ name, avg_days: Math.round(avg(d)), invoices: d.length })).sort((a, b) => b.avg_days - a.avg_days);

  // ── Ventas (tratos ganados) ──
  const won = deals.filter((d) => d.status === 'ganado' && d.closed_at).map((d) => ({ ...d, closed_day: dateInTz(d.closed_at) }));
  const wonYear = won.filter((d) => d.closed_day.startsWith(year));
  const wonMonth = wonYear.filter((d) => d.closed_day.startsWith(month));
  const sumUsd = (arr) => arr.reduce((n, d) => n + conv.toUsd(d.value, d.currency), 0);
  const countryOf = (d) => resolveDealCountry(d.companies?.country, d.pipelines?.name) || 'Sin país';

  const groupWon = (keyFn) => {
    const m = new Map();
    wonYear.forEach((d) => { const k = keyFn(d); const g = m.get(k) || { name: k, won_usd: 0, won_count: 0 }; g.won_usd += conv.toUsd(d.value, d.currency); g.won_count += 1; m.set(k, g); });
    return [...m.values()].map((g) => ({ ...g, won_usd: round2(g.won_usd) })).sort((a, b) => b.won_usd - a.won_usd);
  };
  const byCountry = groupWon(countryOf);
  const byPipeline = groupWon((d) => d.pipelines?.name || 'Sin embudo');
  const byProduct = buildProductInsights(wonYear, conv.toUsd).filter((p) => p.won_count > 0).map((p) => ({ name: p.name, won_usd: p.won_value_usd, won_count: p.won_count }));

  // ── Velocidad de cierre (creado → ganado), último año ──
  const closing = won.filter((d) => d.created_at && d.closed_day >= oneYearAgo)
    .map((d) => ({ d, days: Math.max(0, Math.round((new Date(d.closed_at) - new Date(d.created_at)) / 86400000)) }));

  const UNASSIGNED = 'Sin especificar';
  const top = (arr) => (arr[0] ? { name: arr[0].name, won_usd: arr[0].won_usd } : null);
  // «Sin especificar» no es un país ni un producto líder: es lo que falta clasificar. Se salta como líder y se informa aparte.
  const topReal = (arr) => top(arr.filter((r) => r.name !== UNASSIGNED));
  const gap = (arr) => round2((arr.find((r) => r.name === UNASSIGNED) || {}).won_usd || 0);
  return {
    year: Number(year), month, generated_at: new Date().toISOString(),
    sales: { won_month_usd: round2(sumUsd(wonMonth)), won_ytd_usd: round2(sumUsd(wonYear)), won_count_month: wonMonth.length, won_count_ytd: wonYear.length },
    billing: { facturado_month_usd: round2(facturadoMonth), facturado_ytd_usd: round2(facturadoYtd), invoices_ytd: invoicesYtd },
    collections: {
      cobrado_ytd_usd: round2(cobradoYtd), cobros_month_usd: round2(cobrosMonth),
      por_cobrar_usd: round2(porCobrar), vencido_usd: round2(vencido), vencido_count: vencidoCount,
      collection_rate_pct: facturadoYtd > 0 ? Math.round((cobradoYtd / facturadoYtd) * 100) : null,
      aging: Object.fromEntries(Object.entries(aging).map(([k, v]) => [k, round2(v)])),
      dso_days: dso, dso_sample: paidDays.length, dso_by_account: dsoByAccount,
    },
    top_debtors: [...debtors.values()].map((d) => ({ ...d, overdue_usd: round2(d.overdue_usd) })).sort((a, b) => b.overdue_usd - a.overdue_usd).slice(0, 5),
    slowest_payers: slowest(paidDays.map(({ i, days }) => ({ key: clientOf(i), days })), 2, 5).map((s) => ({ client: s.name, avg_days_to_pay: s.avg_days, invoices: s.deals })),
    leaders: { product: topReal(byProduct), country: topReal(byCountry), pipeline: top(byPipeline) },
    data_gaps: { country_unassigned_usd: gap(byCountry), product_unassigned_usd: gap(byProduct) },
    by_country: byCountry.slice(0, 8), by_product: byProduct.slice(0, 8), by_pipeline: byPipeline.slice(0, 8),
    closing_speed: {
      avg_days: closing.length ? Math.round(avg(closing.map((c) => c.days))) : null, sample: closing.length,
      slowest_pipelines: slowest(closing.map(({ d, days }) => ({ key: d.pipelines?.name || 'Sin embudo', days }))),
      slowest_countries: slowest(closing.map(({ d, days }) => ({ key: countryOf(d), days }))),
      slowest_products: slowest(closing.map(({ d, days }) => ({ key: productOfDeal(d), days }))),
    },
    reconciliation: reconciliation ? reconciliation.totals : null,
    rates: { updated_at: conv.updatedAt, currencies: conv.currencies, missing: [...conv.missing] },
  };
}

module.exports = { computeFinance, slowest, diffDays };
