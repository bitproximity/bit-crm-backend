// Conversión a USD, reglas de actualización, vinculación factura↔trato, métricas del CEO y tratos estáticos.
const http = require('http'); const path = require('path');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const { createFakeDb, install } = require('./fakeSupabase');
const fake = createFakeDb();          // se llena más abajo; hay que instalarla ANTES de cargar los módulos que usan Supabase
const restore = install(fake);

const RATES = [
  { currency: 'COP', rate_to_usd: '0.00025', updated_at: '2026-10-23T00:00:00Z' }, { currency: 'USD', rate_to_usd: 1, updated_at: '2026-10-22T00:00:00Z' },
  { currency: 'MXN', rate_to_usd: 0.055, updated_at: '2026-10-23T00:00:00Z' }, { currency: 'EUR', rate_to_usd: 1.08, updated_at: '2026-10-23T00:00:00Z' },
];
const near = (a, b, d = 0.01) => Math.abs(a - b) <= d;

// ── 1) conversión ────────────────────────────────────────────────────────────────────────────────
const { buildConverter } = require('../src/utils/currency');
{
  const c = buildConverter(RATES);
  ok(c.toUsd(1000000, 'COP') === 250 && c.toUsd(80, 'USD') === 80 && c.toUsd(10, null) === 10 && c.toUsd(10, 'usd') === 10, 'COP a la tasa del día; USD, vacío y minúsculas valen 1');
  ok(c.toUsd(5000000, 'PYG') === 0 && c.missing.has('PYG') && !c.hasRate('PYG') && c.hasRate('COP'), 'una moneda SIN tasa suma 0 y queda anotada (antes se sumaba 1 a 1 con dólares)');
  ok(c.updatedAt === '2026-10-23T00:00:00Z' && c.currencies.join() === 'COP,EUR,MXN,USD', 'sabe de cuándo es la tasa más reciente y qué monedas tiene');
  ok(buildConverter([{ currency: 'COP', rate_to_usd: 0 }]).toUsd(100, 'COP') === 0, 'una tasa en 0 se trata como faltante, no como «gratis»');
}

// ── 2) reglas de actualización de facturas ya sincronizadas ──────────────────────────────────────
const { mergeIncoming } = require('../src/utils/invoiceMerge');
{
  const base = { id: 'i1', status: 'pendiente', paid_amount: 0, total: 1000, due_date: '2026-10-01', currency: 'COP' };
  let r = mergeIncoming(base, { status: 'parcial', paid_amount: 400, total: 1000, due_date: '2026-10-01' });
  ok(r.patch.paid_amount === 400 && r.patch.status === 'parcial' && r.paymentDelta === 400 && !r.discrepancy, 'un cobro nuevo en el origen sube lo cobrado, pasa a «parcial» y devuelve el monto para el historial de pagos');
  r = mergeIncoming({ ...base, status: 'parcial', paid_amount: 400 }, { status: 'pagada', paid_amount: 1000, total: 1000, due_date: '2026-10-01' });
  ok(r.patch.status === 'pagada' && r.paymentDelta === 600, 'completar el cobro → «pagada» por la diferencia');
  r = mergeIncoming({ ...base, status: 'pagada', paid_amount: 1000 }, { status: 'pendiente', paid_amount: 0, total: 1000, due_date: '2026-10-01' });
  ok(Object.keys(r.patch).length === 0 && r.discrepancy.kind === 'pagada_en_crm_abierta_en_origen', 'el CRM dice «pagada» y el origen «abierta»: NO se pisa, se informa como diferencia');
  r = mergeIncoming({ ...base, status: 'parcial', paid_amount: 700 }, { status: 'parcial', paid_amount: 300, total: 1000, due_date: '2026-10-01' });
  ok(!('paid_amount' in r.patch) && !('status' in r.patch) && r.discrepancy.kind === 'cobro_en_crm_no_registrado_en_origen', 'lo cobrado nunca baja: si el CRM tiene más que el origen se informa, no se corrige');
  r = mergeIncoming(base, { status: 'cancelada', paid_amount: 0, total: 1000, due_date: '2026-10-01' });
  ok(r.patch.status === 'cancelada', 'anulada en el origen y sin cobros en el CRM → se cancela');
  r = mergeIncoming({ ...base, status: 'parcial', paid_amount: 300 }, { status: 'cancelada', paid_amount: 0, total: 1000, due_date: '2026-10-01' });
  ok(!('status' in r.patch) && r.discrepancy.kind === 'anulada_en_origen_con_cobros_en_crm', 'anulada en el origen pero con cobros en el CRM → no se cancela, se informa');
  r = mergeIncoming({ ...base, status: 'cancelada', paid_amount: 1000 }, { status: 'pagada', paid_amount: 1000, total: 1000, due_date: '2026-10-01' });
  ok(r.patch.status === 'pagada', 'una factura «cerrada» y cobrada que antes se guardó como cancelada se corrige a «pagada»');
  r = mergeIncoming(base, { status: 'pendiente', paid_amount: 0, total: 1000, due_date: '2026-10-09' });
  ok(r.patch.due_date === '2026-10-09' && Object.keys(r.patch).length === 1, 'el vencimiento se alinea con el origen');
  r = mergeIncoming(base, { status: 'pendiente', paid_amount: 0, total: 1200, subtotal: 1000, tax: 200, due_date: '2026-10-01' });
  ok(r.patch.total === 1200 && r.patch.subtotal === 1000 && r.patch.tax === 200, 'si cambia el total en el origen se alinea (con subtotal e impuesto)');
  r = mergeIncoming(base, { status: 'pendiente', paid_amount: 0, total: 1000, due_date: '2026-10-01' });
  ok(Object.keys(r.patch).length === 0 && r.paymentDelta === 0 && !r.discrepancy, 'sin cambios → no se escribe nada');
}

// ── 3) vinculación factura ↔ trato ganado (parte pura) ───────────────────────────────────────────
const linker = require('../src/utils/invoiceLinker');
const companies = [
  { id: 'c1', name: 'ETH Soluciones Integrales SAS' }, { id: 'c2', name: 'Grupo Ramos' }, { id: 'c3a', name: 'Dos Iguales' }, { id: 'c3b', name: 'Dos Iguales' }, { id: 'c4', name: 'Tuco SAS' },
];
const won = (id, company_id, value, currency, closed_at) => ({ id, title: `Trato ${id}`, company_id, value, currency, closed_at, status: 'ganado', pipelines: { name: 'Bit WiFi' } });
const dealsW = [
  won('d1', 'c1', 1071000, 'COP', '2026-09-01T15:00:00Z'), won('d2', 'c2', 4800, 'USD', '2026-05-10T15:00:00Z'), won('d3', 'c2', 960, 'USD', '2026-06-10T15:00:00Z'),
  won('d4', 'c4', 3000, 'USD', '2025-12-01T15:00:00Z'), won('d5', 'c3a', 500, 'USD', '2026-04-01T15:00:00Z'), won('d6', 'c4', 2000, 'USD', '2026-03-01T15:00:00Z'),
  { ...won('d7', 'c1', 100, 'USD', '2026-02-01T15:00:00Z'), status: 'abierto' },
];
const inv = (id, client_name, total, currency, extra = {}) => ({ id, invoice_number: id, client_name, total, paid_amount: 0, currency, issue_date: '2026-10-01', status: 'pendiente', source_account: 'X', company_id: null, deal_id: null, created_at: '2026-10-22T10:00:00Z', ...extra });
const invoicesW = [
  inv('i1', 'ETH SOLUCIONES INTEGRALES S.A.S', 1071000, 'COP'), inv('i2', 'Grupo Ramos', 960, 'USD'), inv('i3', 'Grupo Ramos', 1234, 'USD'),
  inv('i4', 'Dos Iguales', 500, 'USD'), inv('i5', 'Cliente Desconocido', 50, 'USD'), inv('i6', 'Tuco SAS', 2000, 'USD', { deal_id: 'd6', company_id: 'c4' }),
  inv('i7', 'Anulada SA', 70, 'USD', { status: 'cancelada' }),
];
{
  const rec = linker.buildReconciliation({ invoices: invoicesW, deals: dealsW, companies, rates: RATES, year: 2026 });
  const by = Object.fromEntries(rec.unlinked_invoices.map((r) => [r.id, r]));
  ok(by.i1.confidence === 'alta' && by.i1.company_id === 'c1' && by.i1.suggestions[0].deal_id === 'd1' && by.i1.suggestions[0].amount_match, 'la empresa se reconoce por nombre aunque cambie «S.A.S»/«SAS»/mayúsculas; su único trato ganado es confianza ALTA');
  ok(by.i2.confidence === 'alta' && by.i2.suggestions[0].deal_id === 'd3', 'con dos tratos ganados, el que coincide en monto (USD 960) gana y es confianza alta');
  ok(by.i3.confidence === 'media' && by.i3.suggestions.length === 2, 'dos candidatos y ninguno coincide en monto → «media»: se muestran, no se vinculan solos');
  ok(by.i4.confidence === 'ninguna' && by.i4.company_id === null, 'dos empresas con el mismo nombre: no se adivina cuál');
  ok(by.i5.confidence === 'ninguna', 'cliente que no existe como empresa → sin sugerencia');
  ok(!by.i6 && !by.i7, 'la factura ya vinculada y la anulada sin cobros no salen como «sin trato»');
  ok(rec.totals.invoices_total === 6 && rec.totals.invoices_unlinked === 5 && rec.totals.invoices_linked === 1 && rec.totals.auto_linkable === 2, 'conteos: 6 facturas vigentes, 5 sin trato, 1 vinculada, 2 vinculables con seguridad');
  const wonUsd = 1071000 * 0.00025 + 4800 + 960 + 500 + 2000; // d1+d2+d3+d5+d6 (2026); d4 es 2025 y d7 está abierto
  ok(rec.totals.won_deals === 5 && near(rec.totals.won_usd, wonUsd), 'tratos ganados del año en USD (el de 2025 y el abierto no cuentan)');
  ok(rec.totals.won_with_invoice === 1 && rec.totals.won_without_invoice === 4 && near(rec.totals.won_without_invoice_usd, wonUsd - 2000) && rec.totals.coverage_pct === Math.round(2000 / wonUsd * 100), 'ganado sin factura y % de cobertura');
  ok(rec.won_without_invoice[0].id === 'd2' && rec.won_without_invoice.every((d) => d.id !== 'd6'), 'la lista de ganados sin factura va de mayor a menor USD y no incluye el ya facturado');
  const sinTasa = linker.buildReconciliation({ invoices: [inv('x', 'Tuco SAS', 5000000, 'PYG')], deals: dealsW, companies, rates: RATES, year: 2026 });
  ok(sinTasa.missing_rates.join() === 'PYG' && sinTasa.unlinked_invoices[0].total_usd === 0, 'una moneda sin tasa se avisa y no se infla');
}

// ── 4) métricas del CEO ──────────────────────────────────────────────────────────────────────────
const { computeFinance } = require('../src/utils/financeMetrics');
{
  const fi = (id, client, total, paid, currency, status, issue, due, account = 'Bit LLC') => ({ id, invoice_number: id, client_name: client, total, paid_amount: paid, currency, status, issue_date: issue, due_date: due, source_account: account });
  const invoices = [
    fi('A', 'Cliente A', 1000, 1000, 'USD', 'pagada', '2026-10-05', '2026-11-04'), fi('B', 'Moroso SA', 2000, 0, 'USD', 'pendiente', '2026-08-01', '2026-09-15'),
    fi('C', 'Moroso SA', 4000000, 1000000, 'COP', 'parcial', '2026-09-10', '2026-10-01', 'Bit Colombia SAS'), fi('D', 'Paraguay SA', 10000000, 0, 'PYG', 'pendiente', '2026-10-02', '2026-10-30'),
    fi('E', 'Lento SRL', 500, 500, 'USD', 'pagada', '2026-03-01', '2026-03-31'), fi('F', 'Lento SRL', 800, 800, 'USD', 'pagada', '2026-05-01', '2026-05-31'),
    fi('G', 'Anulada', 9999, 0, 'USD', 'cancelada', '2026-02-01', '2026-02-28'),
  ];
  const payments = [
    { invoice_id: 'A', amount: 1000, paid_at: '2026-10-12T15:00:00Z' }, { invoice_id: 'C', amount: 1000000, paid_at: '2026-10-15T15:00:00Z' },
    { invoice_id: 'E', amount: 500, paid_at: '2026-04-10T15:00:00Z' }, { invoice_id: 'F', amount: 800, paid_at: '2026-06-20T15:00:00Z' },
  ];
  const wd = (id, value, currency, closed, created, pipeline, country) => ({ id, title: id, value, currency, status: 'ganado', closed_at: closed, created_at: created, product_line: pipeline, pipelines: { name: pipeline }, companies: { country } });
  const deals = [
    wd('W1', 5000, 'USD', '2026-10-10T15:00:00Z', '2026-09-10T15:00:00Z', 'Bit WiFi', 'Ecuador'), wd('W2', 3000, 'USD', '2026-07-01T15:00:00Z', '2026-05-02T15:00:00Z', 'Bit Music', 'Colombia'),
    wd('W3', 20000000, 'COP', '2026-08-15T15:00:00Z', '2026-07-16T15:00:00Z', 'Bit WiFi', 'Colombia'), wd('W4', 1000, 'USD', '2025-11-01T15:00:00Z', '2025-10-01T15:00:00Z', 'Bit WiFi', 'Ecuador'),
  ];
  const f = computeFinance({ invoices, payments, deals, rates: RATES.concat([]), today: '2026-10-23', reconciliation: { totals: { coverage_pct: 40 } } });
  ok(f.sales.won_ytd_usd === 13000 && f.sales.won_month_usd === 5000 && f.sales.won_count_ytd === 3 && f.sales.won_count_month === 1, 'ventas: año 13.000 (5.000 + 3.000 + 20 M COP = 5.000), mes 5.000; el trato de 2025 no cuenta');
  ok(f.billing.facturado_ytd_usd === 5300 && f.billing.facturado_month_usd === 1000 && f.billing.invoices_ytd === 6, 'facturado: la anulada no cuenta y los guaraníes sin tasa suman 0');
  ok(f.collections.cobrado_ytd_usd === 2550 && f.collections.cobros_month_usd === 1250 && f.collections.collection_rate_pct === 48, 'cobrado del año 2.550, cobros de octubre 1.250 (1.000 + 1 M COP), tasa de cobranza 48 %');
  ok(f.collections.por_cobrar_usd === 2750 && f.collections.vencido_usd === 2750 && f.collections.vencido_count === 2, 'por cobrar y vencido: 2.000 + 750');
  ok(f.collections.aging['31_60'] === 2000 && f.collections.aging['1_30'] === 750 && f.collections.aging.al_dia === 0 && f.collections.aging.mas_90 === 0, 'antigüedad: 38 días de atraso → 31-60; 22 días → 1-30');
  ok(f.collections.dso_days === 32 && f.collections.dso_sample === 3, 'días promedio de cobro (7, 40 y 50 días) = 32 sobre 3 facturas pagadas');
  ok(f.top_debtors[0].client === 'Moroso SA' && f.top_debtors[0].overdue_usd === 2750 && f.top_debtors[0].invoices === 2 && f.top_debtors[0].max_days_late === 38, 'el moroso principal, con su monto y su mayor atraso');
  ok(f.slowest_payers.length === 1 && f.slowest_payers[0].client === 'Lento SRL' && f.slowest_payers[0].avg_days_to_pay === 45, 'el que más tarda en pagar (promedio 45 días); quien tiene una sola factura no entra');
  ok(f.leaders.country.name === 'Colombia' && f.leaders.country.won_usd === 8000 && f.leaders.product.name === 'Bit WiFi' && f.leaders.product.won_usd === 10000 && f.leaders.pipeline.name === 'Bit WiFi', 'país, producto y embudo que más venden');
  ok(f.closing_speed.avg_days === 38 && f.closing_speed.sample === 4, 'días promedio para cerrar un trato: 38 (30, 60, 30 y 31)');
  ok(f.closing_speed.slowest_countries[0].name === 'Colombia' && f.closing_speed.slowest_countries[0].avg_days === 45 && f.closing_speed.slowest_pipelines[0].name === 'Bit WiFi', 'el país que más se demora en cerrar (Colombia, 45 días)');
  ok(f.rates.missing.join() === 'PYG' && f.reconciliation.coverage_pct === 40, 'avisa que falta la tasa de PYG y trae la cobertura de la conciliación');
}

// líderes: «Sin especificar» no es un país ni un producto líder, es una brecha de datos
{
  const wd = (id, value, pipeline, country, product) => ({ id, title: id, value, currency: 'USD', status: 'ganado', closed_at: '2026-09-10T15:00:00Z', created_at: '2026-08-10T15:00:00Z', product_line: product, pipelines: { name: pipeline }, companies: { country } });
  const g = computeFinance({ invoices: [], payments: [], rates: RATES, today: '2026-10-23', deals: [
    wd('a', 9000, 'Bit WiFi', null, null), wd('b', 4000, 'Bit WiFi', 'Ecuador', 'Bit WiFi'), wd('c', 1500, 'Bit Music', 'Colombia', 'Bit Music'),
  ] });
  ok(g.by_country[0].name === 'Sin especificar' && g.leaders.country.name === 'Ecuador' && g.leaders.country.won_usd === 4000, 'el país que más vende ignora «Sin especificar» (lo mayor, pero no es un país) y devuelve Ecuador');
  ok(g.data_gaps.country_unassigned_usd === 9000, 'y informa cuánto de lo ganado no tiene país asignado (USD 9.000)');
  ok(g.leaders.product.name === 'Bit WiFi' && g.data_gaps.product_unassigned_usd >= 0, 'el producto líder también es uno real');
  const vacio = computeFinance({ invoices: [], payments: [], deals: [wd('x', 100, 'Bit WiFi', null, null)], rates: RATES, today: '2026-10-23' });
  ok(vacio.leaders.country === null && vacio.data_gaps.country_unassigned_usd === 100, 'si todo está sin país, no hay líder (null) y la brecha es todo');
}

// ganados SIN fecha de cierre: no se pueden contar en «ganado del mes/año», se informan aparte
{
  const base = { currency: 'USD', status: 'ganado', created_at: '2026-08-10T15:00:00Z', product_line: 'Bit WiFi', pipelines: { name: 'Bit WiFi' }, companies: { country: 'Ecuador' } };
  const f2 = computeFinance({ invoices: [], payments: [], rates: RATES, today: '2026-10-23', deals: [
    { ...base, id: 'k1', title: 'k1', value: 1000, closed_at: '2026-10-05T15:00:00Z' }, { ...base, id: 'k2', title: 'k2', value: 700, closed_at: null }, { ...base, id: 'k3', title: 'k3', value: 300, closed_at: null },
  ] });
  ok(f2.sales.won_ytd_usd === 1000 && f2.sales.won_count_ytd === 1, 'un ganado sin fecha de cierre no entra en el ganado del año (no se sabe cuándo se ganó)');
  ok(f2.data_gaps.won_without_close_date === 2 && f2.data_gaps.won_without_close_date_usd === 1000, '…pero se informa cuántos son y cuánto suman (2 tratos, USD 1.000) para poder corregirlos');
}

// ── 5) tratos estáticos (parte pura) ─────────────────────────────────────────────────────────────
const { computeStale } = require('../src/utils/staleDeals');
{
  const now = new Date('2026-10-23T12:00:00Z');
  const od = (id, value, currency, created, owner_id, owner) => ({ id, title: id, value, currency, created_at: created, owner_id, team_members: owner ? { full_name: owner } : null, companies: { name: `Cliente ${id}` }, pipelines: { name: 'Bit WiFi' }, pipeline_stages: { name: 'Propuesta' } });
  const deals = [od('s1', 8000, 'USD', '2026-01-01T00:00:00Z', 'u1', 'Sofia'), od('s2', 900, 'USD', '2026-10-20T00:00:00Z', 'u1', 'Sofia'), od('s3', 4000000, 'COP', '2026-06-01T00:00:00Z', 'u2', 'Ana'), od('s4', 500, 'USD', '2026-01-10T00:00:00Z', null, null), od('s5', 700, 'USD', '2026-02-01T00:00:00Z', 'u1', 'Sofia')];
  const activities = [
    { entity_id: 's1', occurred_at: '2026-10-01T10:00:00Z', type: 'llamada', summary: 'Llamé al gerente' }, { entity_id: 's3', occurred_at: '2026-11-01T10:00:00Z', type: 'reunion', summary: 'Reunión agendada a futuro' },
    { entity_id: 's5', occurred_at: '2026-10-15T10:00:00Z', type: 'nota', summary: 'Seguimiento' },
  ];
  const history = [{ deal_id: 's3', changed_at: '2026-09-01T10:00:00Z' }];
  const tasks = [{ deal_id: 's3', title: 'Reactivar: s3', status: 'pendiente' }, { deal_id: 's1', title: 'Otra', status: 'completada' }];
  const r = computeStale({ deals, activities, history, tasks, rates: RATES, now, days: 14 });
  ok(r.deals.map((d) => d.id).join() === 's1,s3,s4', 'estáticos (14+ días): s1, s3 y s4; el creado hace 3 días y el movido hace 8 quedan fuera; orden por USD');
  ok(r.deals[0].days_idle === 22 && r.deals[0].last_touch_kind === 'actividad' && r.deals[0].last_activity.summary === 'Llamé al gerente' && r.deals[0].priority === 'alta', 's1: 22 días desde su última actividad, prioridad alta (USD 8.000)');
  ok(r.deals[1].days_idle === 52 && r.deals[1].last_touch_kind === 'cambio de etapa' && r.deals[1].value_usd === 1000 && r.deals[1].priority === 'media', 's3: una reunión agendada a FUTURO no cuenta como movimiento; vale el cambio de etapa; COP convertido');
  ok(r.deals[2].days_idle === 286 && r.deals[2].last_touch_kind === 'creación' && r.deals[2].priority === 'baja', 's4: sin nada registrado cuenta desde su creación');
  ok(r.deals[1].has_reminder && r.deals[1].open_tasks === 1 && r.deals[0].open_tasks === 0 && !r.deals[0].has_reminder, 'distingue el trato que ya tiene recordatorio y los que no tienen siguiente paso (una tarea completada no cuenta)');
  ok(r.summary.count === 3 && r.summary.value_usd === 9500 && r.summary.without_next_step === 2 && r.summary.with_reminder === 1, 'resumen: 3 tratos, USD 9.500 en juego, 2 sin siguiente paso');
  ok(r.summary.buckets['14_29'].count === 1 && r.summary.buckets['30_59'].count === 1 && r.summary.buckets['90_mas'].count === 1 && r.summary.buckets['60_89'].count === 0, 'agrupados por antigüedad');
  ok(r.summary.by_owner[0].owner === 'Sofia' && r.summary.by_owner[0].count === 1 && r.summary.by_owner.some((o) => o.owner === 'Sin responsable'), 'por responsable, incluido «Sin responsable»');
  ok(computeStale({ deals, activities, history, tasks, rates: RATES, now, days: 60 }).deals.map((d) => d.id).join() === 's4', 'con 60 días solo queda el que lleva 286');
}

// ── 6) servicios (con base simulada) ─────────────────────────────────────────────────────────────
Object.assign(fake.db, JSON.parse(JSON.stringify({
  exchange_rates: RATES, companies, deals: dealsW.map((d) => ({ ...d, owner_id: 'u-admin', created_at: '2026-01-01T00:00:00Z', companies: { country: 'Ecuador' } })),
  invoices: invoicesW, invoice_payments: [], tasks: [], activities: [], deal_stage_history: [],
})));
const express = require(path.resolve(__dirname, '../node_modules/express'));
const app = express(); app.use(express.json());
app.use('/api/finance', require('../src/routes/finance'));
app.use('/api/stale-deals', require('../src/routes/staleDeals'));
app.use('/api/invoices', require('../src/routes/invoices'));
const srv = app.listen(0, async () => {
  const call = (method, p, body, role) => new Promise((resolve) => {
    const req = http.request({ port: srv.address().port, path: p, method, headers: { 'Content-Type': 'application/json', ...(role ? { 'x-role': role } : {}) } }, (res) => {
      let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve({ status: res.statusCode, json: s ? JSON.parse(s) : null }));
    });
    if (body) req.write(JSON.stringify(body)); req.end();
  });

  let r = await call('GET', '/api/finance/reconciliation?year=2026');
  ok(r.status === 200 && r.json.totals.invoices_unlinked === 5 && r.json.totals.auto_linkable === 2, 'GET /api/finance/reconciliation responde la conciliación');
  r = await call('GET', '/api/finance');
  ok(r.status === 200 && r.json.collections && r.json.sales && r.json.rates && r.json.reconciliation.invoices_total === 6, 'GET /api/finance responde las métricas del CEO con la conciliación incluida');

  r = await call('POST', '/api/finance/auto-link', { dry_run: true }, 'outbound'); ok(r.status === 403, 'solo el admin puede vincular automáticamente');
  r = await call('POST', '/api/finance/auto-link', { dry_run: true });
  ok(r.status === 200 && r.json.dry_run && r.json.linked_deals === 2 && r.json.linked_companies === 3 && fake.db.invoices.find((i) => i.id === 'i1').deal_id === null, 'ensayo: planea 2 vínculos a tratos y 3 a empresas (i1, i2 y la «media» i3 solo empresa) sin escribir nada');
  r = await call('POST', '/api/finance/auto-link', {});
  const get = (id) => fake.db.invoices.find((i) => i.id === id);
  ok(r.json.linked_deals === 2 && get('i1').deal_id === 'd1' && get('i1').company_id === 'c1' && get('i2').deal_id === 'd3' && get('i2').company_id === 'c2', 'vincula i1→d1 y i2→d3 (con su empresa)');
  ok(get('i3').deal_id === null && get('i3').company_id === 'c2', 'la «media» (i3) solo recibe su empresa, NO un trato adivinado; las ambiguas quedan igual');
  ok(get('i4').company_id === null && get('i5').company_id === null && get('i7').deal_id === null, 'ni la empresa duplicada, ni la desconocida, ni la anulada se tocan');
  ok(fake.db.audit_log.filter((a) => a.type === 'invoice' && a.changes?.auto_link).length === 3, 'cada vínculo automático queda en la auditoría');
  r = await call('POST', '/api/finance/auto-link', {}); ok(r.json.linked_deals === 0 && r.json.linked_companies === 0, 'repetirlo no cambia nada');
  r = await call('GET', '/api/finance/reconciliation?year=2026');
  ok(r.json.totals.invoices_unlinked === 3 && r.json.totals.won_with_invoice === 3, 'después de vincular, la cobertura sube (d1, d3 y d6 ya tienen factura)');

  // vinculación solo de facturas recién llegadas
  fake.db.invoices.push(inv('i8', 'Tuco SAS', 3000, 'USD', { created_at: '2020-01-01T00:00:00Z' }), inv('i9', 'Tuco SAS', 3000, 'USD', { created_at: new Date().toISOString() }));
  const recent = await linker.applyAutoLinks({ createdSince: new Date(Date.now() - 3 * 86400000).toISOString(), dryRun: true });
  ok(recent.plan.some((p) => p.invoice_id === 'i9') && !recent.plan.some((p) => p.invoice_id === 'i8'), 'el sincronizador solo vincula lo recién llegado; el histórico espera la revisión de alguien');

  // lista y resumen de facturas en USD
  fake.db.invoices.push(inv('late1', 'Tardío SA', 100, 'USD', { due_date: '2020-01-01' }), inv('pyg1', 'Paraguay SA', 5000000, 'PYG'));
  r = await call('GET', '/api/invoices');
  const L = Object.fromEntries(r.json.map((x) => [x.id, x]));
  ok(r.status === 200 && near(L.i1.total_usd, 267.75) && L.i1.currency === 'COP' && L.i1.total === 1071000, 'cada factura sale con su equivalente en USD y conserva su monto en la moneda original');
  ok(L.late1.overdue === true && L.late1.days_late > 1000 && L.late1.pending_usd === 100 && L.i6.days_late === 0 && L.i6.overdue === false, 'días de atraso y por cobrar en USD; la que no vence no tiene atraso');
  ok(L.pyg1.rate_missing === true && L.pyg1.total_usd === 0 && L.i1.rate_missing === false, 'una factura en una moneda sin tasa lo dice (rate_missing) y no se infla');
  r = await call('GET', '/api/invoices/summary');
  const vivas = fake.db.invoices.filter((x) => !(x.status === 'cancelada' && Number(x.paid_amount || 0) === 0)).length;
  ok(r.status === 200 && r.json.missing_rates.join() === 'PYG' && r.json.count === vivas && r.json.count_overdue >= 1 && typeof r.json.collection_rate_pct === 'number' && r.json.rates_updated_at, 'resumen: avisa de la moneda sin tasa, no cuenta la anulada sin cobros y trae atraso, tasa de cobranza y fecha de las tasas');

  // marcar una factura como pagada registra el pago con su fecha (antes solo cambiaba el monto)
  fake.db.invoices.push(inv('pay1', 'Tuco SAS', 500, 'USD'));
  const pagos = () => fake.db.invoice_payments.filter((p) => p.invoice_id === 'pay1');
  r = await call('PATCH', '/api/invoices/pay1', { status: 'pagada', paid_amount: 500 });
  ok(r.status === 200 && pagos().length === 1 && pagos()[0].amount === 500 && pagos()[0].method === 'Marcada como pagada' && pagos()[0].paid_at, 'marcar «pagada» crea un pago por el monto cobrado, con su fecha');
  r = await call('PATCH', '/api/invoices/pay1', { client_name: 'Tuco SAS (editado)' });
  ok(pagos().length === 1, 'editar otra cosa de la factura no crea pagos');
  r = await call('PATCH', '/api/invoices/pay1', { status: 'pendiente', paid_amount: 0 });
  ok(pagos().length === 0 && get('pay1').paid_amount === 0, 'volver a «pendiente» retira ese pago');
  r = await call('PATCH', '/api/invoices/pay1', { paid_amount: 200 }); r = await call('PATCH', '/api/invoices/pay1', { paid_amount: 500 });
  ok(pagos().map((p) => p.amount).join() === '200,300', 'un cobro parcial y luego el resto quedan como dos pagos (200 y 300)');
  fake.db.invoice_payments.push({ id: 'manual', invoice_id: 'pay1', amount: 50, method: 'Transferencia', paid_at: '2026-10-01T00:00:00Z' });
  r = await call('PATCH', '/api/invoices/pay1', { paid_amount: 0, status: 'pendiente' });
  ok(fake.db.invoice_payments.some((p) => p.id === 'manual') && pagos().length === 1, 'solo se retiran los pagos creados al marcar; un pago registrado a mano no se borra');

  // tratos estáticos
  fake.db.deals.push({ id: 'o1', title: 'Abierto viejo', value: 6000, currency: 'USD', status: 'abierto', owner_id: 'u-ana', created_at: '2026-01-01T00:00:00Z', companies: { name: 'Acme' }, pipelines: { name: 'Bit WiFi' }, pipeline_stages: { name: 'Demo' }, team_members: { full_name: 'Ana' } },
    { id: 'o2', title: 'Abierto sin dueño', value: 1200, currency: 'USD', status: 'abierto', owner_id: null, created_at: '2026-01-02T00:00:00Z', companies: { name: 'Beta' }, pipelines: { name: 'Bit WiFi' }, pipeline_stages: { name: 'Demo' }, team_members: null },
    { id: 'o3', title: 'Abierto reciente', value: 100, currency: 'USD', status: 'abierto', owner_id: 'u-ana', created_at: new Date().toISOString(), companies: { name: 'Gamma' }, pipelines: { name: 'Bit WiFi' }, pipeline_stages: { name: 'Demo' }, team_members: { full_name: 'Ana' } });
  for (const rol of ['wifi_partner', 'outbound']) {
    r = await call('GET', '/api/stale-deals?days=14', null, rol); const r2 = await call('POST', '/api/stale-deals/remind', { deal_ids: ['o1'] }, rol);
    ok(r.status === 403 && r2.status === 403, `el rol «${rol}» no puede ver ni reactivar los tratos estáticos de todos los embudos`);
  }
  r = await call('GET', '/api/stale-deals?days=14', null, 'operaciones'); ok(r.status === 200, 'operaciones sí puede');
  r = await call('GET', '/api/stale-deals?days=14');
  ok(r.status === 200 && r.json.deals.map((d) => d.id).join() === 'o1,o2,d7' && r.json.summary.value_usd === 7300 && r.json.days === 14, 'GET /api/stale-deals lista los estáticos por USD y solo los abiertos (los ganados no entran)');
  r = await call('GET', '/api/stale-deals?days=9999'); ok(r.json.days === 365, 'el umbral se limita a 1–365 días');
  r = await call('POST', '/api/stale-deals/remind', { deal_ids: [] }); ok(r.status === 400, 'sin tratos → 400');
  r = await call('POST', '/api/stale-deals/remind', { deal_ids: ['o1', 'o2', 'd1', 'o3'] });
  const tareas = fake.db.tasks;
  ok(r.status === 201 && r.json.created === 3 && tareas.length === 3, 'crea un recordatorio por trato abierto (el ganado d1 se omite como no abierto)');
  ok(r.json.not_open === 1, 'informa cuántos no estaban abiertos');
  const t1 = tareas.find((t) => t.deal_id === 'o1'); const t2 = tareas.find((t) => t.deal_id === 'o2');
  ok(t1.title === 'Reactivar: Abierto viejo' && t1.assignee_id === 'u-ana' && t1.status === 'pendiente' && t1.priority === 'alta' && /^\d{4}-\d{2}-\d{2}T14:00:00/.test(t1.due_date), 'la tarea va al responsable del trato, con prioridad alta y vence a las 9:00 a. m. de Panamá');
  ok(t2.assignee_id === 'u-admin', 'si el trato no tiene responsable, la recibe quien la pide');
  ok(fake.db.notifications.filter((n) => n.recipient_id === 'u-ana').length === 1 && fake.db.notifications[0].title.includes('2 recordatorios'), 'un solo aviso por persona (no uno por tarea)');
  r = await call('POST', '/api/stale-deals/remind', { deal_ids: ['o1', 'o2'] });
  ok(r.json.created === 0 && r.json.already_had_reminder === 2 && fake.db.tasks.length === 3, 'repetirlo no duplica recordatorios');
  require('../src/utils/memo').clearAll(); // el servidor real lo hace tras cada escritura (server.js)
  r = await call('GET', '/api/stale-deals?days=14');
  ok(r.json.deals.filter((d) => ['o1', 'o2'].includes(d.id)).every((d) => d.has_reminder) && !r.json.deals.find((d) => d.id === 'd7').has_reminder && r.json.summary.with_reminder === 2, 'la lista marca los que ya tienen recordatorio');

  // depuración en bloque: asignar responsable y cerrar como perdidos
  Object.assign(fake.db, { team_members: [{ id: 'u-ana', full_name: 'Ana Espinel', active: true }, { id: 'u-off', full_name: 'Persona Inactiva', active: false }] });
  const dealRow = (id) => fake.db.deals.find((d) => d.id === id);
  r = await call('POST', '/api/stale-deals/assign', { deal_ids: ['o2', 'd1', 'o3'], owner_id: 'u-ana' }, 'wifi_partner'); ok(r.status === 403, 'el socio externo no puede asignar tratos');
  r = await call('POST', '/api/stale-deals/assign', { deal_ids: [], owner_id: 'u-ana' }); ok(r.status === 400, 'asignar sin tratos → 400');
  r = await call('POST', '/api/stale-deals/assign', { deal_ids: ['o2'] }); ok(r.status === 400, 'asignar sin responsable → 400');
  r = await call('POST', '/api/stale-deals/assign', { deal_ids: ['o2'], owner_id: 'nadie' }); ok(r.status === 400, 'un responsable que no existe → 400');
  r = await call('POST', '/api/stale-deals/assign', { deal_ids: ['o2'], owner_id: 'u-off' }); ok(r.status === 400 && dealRow('o2').owner_id === null, 'un responsable inactivo → 400 y no se asigna');
  fake.db.notifications.length = 0;
  r = await call('POST', '/api/stale-deals/assign', { deal_ids: ['o2', 'd1', 'o3'], owner_id: 'u-ana' });
  ok(r.status === 200 && r.json.updated === 2 && r.json.skipped === 1 && r.json.owner === 'Ana Espinel', 'asigna a Ana los 2 tratos abiertos y salta el que no lo está');
  ok(dealRow('o2').owner_id === 'u-ana' && dealRow('o3').owner_id === 'u-ana' && dealRow('d1').owner_id === 'u-admin', 'el trato ganado no se toca');
  ok(fake.db.notifications.filter((n) => n.recipient_id === 'u-ana' && /Te asignaron 2 tratos/.test(n.title)).length === 1, 'un solo aviso a la persona, con el total');

  r = await call('POST', '/api/stale-deals/close-lost', { deal_ids: ['o1', 'd1'], reason: 'Precio muy alto' }, 'operaciones'); ok(r.status === 403 && dealRow('o1').status === 'abierto', 'cerrar tratos como perdidos en bloque es solo para administración');
  fake.db.notifications.length = 0; const auditoriaAntes = fake.db.audit_log.length;
  r = await call('POST', '/api/stale-deals/close-lost', { deal_ids: ['o1', 'd1'], reason: 'Precio muy alto' });
  ok(r.status === 200 && r.json.closed === 1 && r.json.skipped === 1 && r.json.reason === 'Precio muy alto', 'cierra el trato abierto y salta el ganado');
  ok(dealRow('o1').status === 'perdido' && dealRow('o1').lost_reason === 'Precio muy alto' && dealRow('o1').closed_at && dealRow('d1').status === 'ganado', 'queda perdido con su motivo y fecha; el ganado sigue ganado');
  ok(fake.db.audit_log.length === auditoriaAntes + 1 && fake.db.notifications.some((n) => n.recipient_id === 'u-ana' && /1 de tus tratos se cerraron como perdidos/.test(n.title)), 'queda en la auditoría y el responsable recibe un aviso');
  r = await call('POST', '/api/stale-deals/close-lost', { deal_ids: ['o3'], reason: '   ' }); ok(r.json.closed === 1 && dealRow('o3').lost_reason === 'Dejó de responder', 'sin motivo usa «Dejó de responder»');
  r = await call('POST', '/api/stale-deals/close-lost', { deal_ids: [] }); ok(r.status === 400, 'cerrar sin tratos → 400');
  require('../src/utils/memo').clearAll();
  r = await call('GET', '/api/stale-deals?days=14'); ok(!r.json.deals.some((d) => ['o1', 'o3'].includes(d.id)), 'los cerrados ya no aparecen como estáticos');

  // aviso diario
  const { notifyStaleOwners } = require('../src/utils/staleRemindersScheduler');
  fake.db.notifications.length = 0;
  await notifyStaleOwners();
  const avisos = fake.db.notifications.filter((n) => n.type === 'stale_deals');
  const ana = avisos.find((n) => n.recipient_id === 'u-ana');
  ok(avisos.length === 2 && ana.title.includes('1 trato') && ana.title.includes('1,200') && ana.link === '/stale-deals', 'aviso diario: un mensaje por responsable con cuántos tratos y cuánto dinero (el trato sin responsable no avisa a nadie)');
  await notifyStaleOwners();
  ok(fake.db.notifications.filter((n) => n.type === 'stale_deals').length === 2, 'no se repite el mismo día (un deploy no vuelve a avisar)');

  fake.failTables.add('deal_stage_history');
  r = await call('GET', '/api/stale-deals?days=15');
  ok(r.status === 500 && /tratos estáticos/.test(r.json.error), 'si falla una consulta lo dice (no devuelve una lista vacía como si no hubiera nada)');
  fake.failTables.delete('deal_stage_history');
  srv.close(); restore();
});
