// Conciliación entre FACTURAS y TRATOS GANADOS.
//
// Hasta ahora la relación era 100 % manual (alguien abría cada factura y buscaba el trato), así que nadie podía
// responder «¿qué de lo que ganamos ya se facturó?» ni «¿qué facturas no tienen trato?». Aquí:
//   · cada factura sin trato recibe el trato ganado más probable de SU empresa, con un nivel de confianza
//   · «alta» solo cuando es casi seguro: la empresa se reconoce por nombre sin ambigüedad Y (tiene un único
//     trato ganado, o un único trato ganado cuyo monto coincide con el de la factura)
//   · «media» cuando hay varios candidatos: se muestran, pero NO se vinculan solos
//   · se listan los tratos ganados del año que no tienen ninguna factura vinculada (dinero ganado sin facturar)
const supabase = require('../config/supabase');
const { fetchAll } = require('./fetchAll');
const { normalizeCompanyName } = require('./mergeRecords');
const { buildConverter, round2 } = require('./currency');
const { logAudit } = require('./audit');
const { todayInTz } = require('./businessDate');

const AMOUNT_TOLERANCE = 0.03; // un 3 % de diferencia entre la factura y el valor del trato sigue siendo «el mismo monto»
const isVoid = (inv) => inv.status === 'cancelada' && Number(inv.paid_amount || 0) === 0;

function buildContext({ invoices, deals, companies, rates }) {
  const converter = buildConverter(rates);
  const companyName = new Map();
  const companiesByName = new Map();
  for (const c of companies || []) {
    companyName.set(c.id, c.name);
    const key = normalizeCompanyName(c.name || '');
    if (!key) continue;
    if (!companiesByName.has(key)) companiesByName.set(key, []);
    companiesByName.get(key).push(c.id);
  }
  const wonByCompany = new Map();
  for (const d of deals || []) {
    if (d.status !== 'ganado' || !d.company_id) continue;
    if (!wonByCompany.has(d.company_id)) wonByCompany.set(d.company_id, []);
    wonByCompany.get(d.company_id).push(d);
  }
  const linkedDealIds = new Set((invoices || []).filter((i) => i.deal_id && !isVoid(i)).map((i) => i.deal_id));
  return { converter, companyName, companiesByName, wonByCompany, linkedDealIds };
}

// Empresa de la factura: la que ya tiene, o la única que coincide por nombre (nunca una adivinanza entre varias).
function companyIdFor(inv, ctx) {
  if (inv.company_id) return { id: inv.company_id, how: 'existente' };
  const key = normalizeCompanyName(inv.client_name || '');
  const ids = key ? ctx.companiesByName.get(key) : null;
  return ids && ids.length === 1 ? { id: ids[0], how: 'nombre' } : { id: null, how: null };
}

function sameAmount(inv, deal, converter) {
  const a = converter.toUsd(inv.total, inv.currency);
  const b = converter.toUsd(deal.value, deal.currency);
  return a > 0 && b > 0 && Math.abs(a - b) / Math.max(a, b) <= AMOUNT_TOLERANCE;
}

function suggestForInvoice(inv, ctx) {
  const company = companyIdFor(inv, ctx);
  if (!company.id) return { company_id: null, company_how: null, confidence: 'ninguna', suggestions: [] };
  const won = ctx.wonByCompany.get(company.id) || [];
  const suggestions = won
    .map((d) => ({
      deal_id: d.id, title: d.title, value: d.value, currency: d.currency,
      value_usd: round2(ctx.converter.toUsd(d.value, d.currency)), closed_at: d.closed_at || null,
      amount_match: sameAmount(inv, d, ctx.converter),
    }))
    .sort((a, b) => Number(b.amount_match) - Number(a.amount_match) || String(b.closed_at).localeCompare(String(a.closed_at)))
    .slice(0, 4);
  const matches = suggestions.filter((s) => s.amount_match);
  let confidence = 'ninguna';
  if (won.length === 1) confidence = 'alta';
  else if (matches.length === 1) confidence = 'alta';
  else if (won.length > 1) confidence = 'media';
  return { company_id: company.id, company_how: company.how, confidence, suggestions };
}

// Foto completa de la conciliación para un año (por defecto, el actual en la zona del negocio).
function buildReconciliation({ invoices, deals, companies, rates, year, limit = 300 }) {
  const ctx = buildContext({ invoices, deals, companies, rates });
  const y = String(year || todayInTz().slice(0, 4));
  const live = (invoices || []).filter((i) => !isVoid(i));
  const unlinked = live.filter((i) => !i.deal_id);

  const unlinkedRows = unlinked.map((inv) => {
    const sug = suggestForInvoice(inv, ctx);
    return {
      id: inv.id, invoice_number: inv.invoice_number, client_name: inv.client_name, source_account: inv.source_account,
      status: inv.status, issue_date: inv.issue_date, total: Number(inv.total || 0), currency: inv.currency,
      total_usd: round2(ctx.converter.toUsd(inv.total, inv.currency)),
      company_id: sug.company_id, company_name: sug.company_id ? ctx.companyName.get(sug.company_id) || null : null,
      company_how: sug.company_how, confidence: sug.confidence, suggestions: sug.suggestions,
    };
  }).sort((a, b) => b.total_usd - a.total_usd);

  const wonYear = (deals || []).filter((d) => d.status === 'ganado' && String(d.closed_at || '').slice(0, 4) === y);
  const wonRows = wonYear.map((d) => ({
    id: d.id, title: d.title, company_id: d.company_id, company_name: d.company_id ? ctx.companyName.get(d.company_id) || null : null,
    value: Number(d.value || 0), currency: d.currency, value_usd: round2(ctx.converter.toUsd(d.value, d.currency)),
    closed_at: d.closed_at, product_line: d.product_line || null, pipeline: d.pipelines?.name || null, has_invoice: ctx.linkedDealIds.has(d.id),
  }));
  const withInvoice = wonRows.filter((d) => d.has_invoice);
  const withoutInvoice = wonRows.filter((d) => !d.has_invoice).sort((a, b) => b.value_usd - a.value_usd);
  const sum = (arr, k) => round2(arr.reduce((n, r) => n + r[k], 0));
  const wonUsd = sum(wonRows, 'value_usd');

  return {
    year: Number(y),
    totals: {
      won_deals: wonRows.length, won_usd: wonUsd,
      won_with_invoice: withInvoice.length, won_with_invoice_usd: sum(withInvoice, 'value_usd'),
      won_without_invoice: withoutInvoice.length, won_without_invoice_usd: sum(withoutInvoice, 'value_usd'),
      coverage_pct: wonUsd > 0 ? Math.round((sum(withInvoice, 'value_usd') / wonUsd) * 100) : null,
      invoices_total: live.length, invoices_linked: live.length - unlinkedRows.length,
      invoices_unlinked: unlinkedRows.length, invoices_unlinked_usd: sum(unlinkedRows, 'total_usd'),
      auto_linkable: unlinkedRows.filter((r) => r.confidence === 'alta').length,
    },
    unlinked_invoices: unlinkedRows.slice(0, limit),
    won_without_invoice: withoutInvoice.slice(0, limit),
    missing_rates: [...ctx.converter.missing],
  };
}

async function loadData({ year } = {}) {
  const [inv, dls, cmp, rates] = await Promise.all([
    fetchAll(supabase.from('invoices').select('id, invoice_number, client_name, company_id, deal_id, total, paid_amount, currency, issue_date, status, source_account, created_at')),
    fetchAll(supabase.from('deals').select('id, title, value, currency, company_id, closed_at, status, product_line, pipelines(name)').eq('status', 'ganado')),
    fetchAll(supabase.from('companies').select('id, name')),
    supabase.from('exchange_rates').select('*'),
  ]);
  const failed = [inv, dls, cmp].find((r) => r.error);
  if (failed) throw new Error(failed.error.message);
  return { invoices: inv.data || [], deals: dls.data || [], companies: cmp.data || [], rates: rates.data || [], year };
}

// Vincula lo que es casi seguro: el trato (confianza «alta») y, aparte, la empresa cuando el nombre la identifica sin ambigüedad.
// `createdSince` limita a facturas recién llegadas (así el sincronizador deja lista cada factura nueva sin tocar el histórico
// sin que nadie lo revise); `dryRun` solo calcula el plan.
async function applyAutoLinks({ dryRun = false, createdSince = null, actorId = null } = {}) {
  const data = await loadData();
  const ctx = buildContext(data);
  const candidates = data.invoices.filter((i) => !isVoid(i) && (!createdSince || String(i.created_at || '') >= createdSince));
  const plan = [];
  for (const inv of candidates) {
    const sug = suggestForInvoice(inv, ctx);
    const update = {};
    if (!inv.company_id && sug.company_id && sug.company_how === 'nombre') update.company_id = sug.company_id;
    if (!inv.deal_id && sug.confidence === 'alta' && sug.suggestions[0]) update.deal_id = sug.suggestions[0].deal_id;
    if (Object.keys(update).length) plan.push({ invoice_id: inv.id, invoice_number: inv.invoice_number, ...update, deal_title: update.deal_id ? sug.suggestions[0].title : null });
  }
  if (!dryRun) {
    for (const p of plan) {
      const { invoice_id, invoice_number, deal_title, ...update } = p; // eslint-disable-line no-unused-vars
      const { error } = await supabase.from('invoices').update({ ...update, updated_at: new Date().toISOString() }).eq('id', invoice_id);
      if (error) { p.error = error.message; continue; }
      if (actorId) await logAudit('invoice', invoice_id, 'updated', actorId, { auto_link: { deal_id: update.deal_id || null, company_id: update.company_id || null } });
    }
  }
  return {
    dry_run: dryRun,
    linked_deals: plan.filter((p) => p.deal_id && !p.error).length,
    linked_companies: plan.filter((p) => p.company_id && !p.error).length,
    plan: plan.slice(0, 200),
  };
}

module.exports = { buildContext, companyIdFor, suggestForInvoice, buildReconciliation, applyAutoLinks, loadData, AMOUNT_TOLERANCE };
