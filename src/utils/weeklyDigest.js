// Resumen semanal por correo (lunes 8:00, hora del negocio): cómo cerró la semana anterior —ganado,
// facturado, cobrado— comparado con la semana previa, cuánto hay por cobrar y vencido hoy, quién más
// debe y cuántos tratos abiertos tiene cada vendedor sin actividad al día. Todo en USD a la tasa del día.
// Lo reciben los admins con acceso a Facturación (son montos reales). No se repite en la misma semana.
const supabase = require('../config/supabase');
const { fetchAll } = require('./fetchAll');
const { buildConverter } = require('./currency');
const { dateInTz, todayInTz, BUSINESS_TZ } = require('./businessDate');
const { sendEmail } = require('./email');
const { createNotification } = require('./notify');
const { escapeHtml } = require('./escape');
const { loadActivityHealth } = require('./activityHealth');

const CRM_URL = 'https://crm.bitproximity.com';
const DAY = 86400000;
const toDay = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
const fromDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const usd = (n) => `USD ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

// Semana anterior completa (lunes a domingo) y la previa, vistas desde la fecha de hoy del negocio.
function weekRanges(today) {
  const t = toDay(today);
  const dow = new Date(t).getUTCDay();            // 0 = domingo
  const thisMonday = t - ((dow + 6) % 7) * DAY;
  const start = thisMonday - 7 * DAY;
  return {
    week: { from: fromDay(start), to: fromDay(start + 6 * DAY) },
    prev: { from: fromDay(start - 7 * DAY), to: fromDay(start - DAY) },
    this_monday: fromDay(thisMonday),
  };
}

function computeWeeklyDigest({ today, deals = [], invoices = [], payments = [], rates = [], activityHealth = null }) {
  const conv = buildConverter(rates);
  const { week, prev } = weekRanges(today);
  const inRange = (day, r) => !!day && day >= r.from && day <= r.to;
  const dayOf = (ts) => (ts ? dateInTz(ts) : null);
  const sumDeals = (list) => list.reduce((n, d) => n + conv.toUsd(d.value, d.currency), 0);

  const period = (r) => {
    const won = deals.filter((d) => d.status === 'ganado' && inRange(dayOf(d.closed_at), r));
    const lost = deals.filter((d) => d.status === 'perdido' && inRange(dayOf(d.closed_at), r));
    const created = deals.filter((d) => inRange(dayOf(d.created_at), r));
    const issued = invoices.filter((i) => i.status !== 'cancelada' && inRange(String(i.issue_date || '').slice(0, 10), r));
    const paid = payments.filter((p) => inRange(dayOf(p.paid_at), r));
    return {
      won_count: won.length, won_usd: sumDeals(won), won,
      lost_count: lost.length, new_count: created.length, new_usd: sumDeals(created),
      invoiced_count: issued.length, invoiced_usd: issued.reduce((n, i) => n + conv.toUsd(i.total, i.currency), 0),
      collected_usd: paid.reduce((n, p) => n + conv.toUsd(p.amount, p.invoices?.currency || 'USD'), 0),
    };
  };
  const cur = period(week);
  const before = period(prev);

  const open = invoices.filter((i) => i.status === 'pendiente' || i.status === 'parcial');
  const pendingOf = (i) => Math.max(conv.toUsd(i.total, i.currency) - conv.toUsd(i.paid_amount, i.currency), 0);
  const overdue = open.filter((i) => i.due_date && String(i.due_date).slice(0, 10) < today);
  const debtors = new Map();
  for (const i of overdue) {
    const name = i.client_name || i.companies?.name || 'Sin nombre';
    const d = debtors.get(name) || { client: name, usd: 0, invoices: 0, max_days: 0 };
    d.usd += pendingOf(i); d.invoices += 1;
    d.max_days = Math.max(d.max_days, Math.round((toDay(today) - toDay(i.due_date)) / DAY));
    debtors.set(name, d);
  }

  return {
    today, week, prev,
    won: { count: cur.won_count, usd: cur.won_usd, prev_usd: before.won_usd, top: cur.won.map((d) => ({ title: d.title, usd: conv.toUsd(d.value, d.currency) })).sort((a, b) => b.usd - a.usd).slice(0, 5) },
    lost_count: cur.lost_count,
    new_deals: { count: cur.new_count, usd: cur.new_usd },
    invoiced: { count: cur.invoiced_count, usd: cur.invoiced_usd, prev_usd: before.invoiced_usd },
    collected: { usd: cur.collected_usd, prev_usd: before.collected_usd },
    receivable_usd: open.reduce((n, i) => n + pendingOf(i), 0),
    overdue: { count: overdue.length, usd: overdue.reduce((n, i) => n + pendingOf(i), 0), top: [...debtors.values()].sort((a, b) => b.usd - a.usd).slice(0, 5) },
    activity: activityHealth,
  };
}

const fmtRange = (r) => {
  const f = (s) => new Date(`${s}T12:00:00Z`).toLocaleDateString('es', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${f(r.from)} – ${f(r.to)}`;
};

function delta(nowV, prevV) {
  if (!(prevV > 0)) return nowV > 0 ? '<span style="color:#888">semana previa: USD 0</span>' : '';
  const pct = Math.round(((nowV - prevV) / prevV) * 100);
  const color = pct >= 0 ? '#0a8a4a' : '#c0392b';
  return `<span style="color:${color}">${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}%</span> <span style="color:#888">vs semana previa (${usd(prevV)})</span>`;
}

function renderDigestHtml(d, name = '') {
  const card = (label, value, sub = '') => `
    <td style="padding:12px 14px;border:1px solid #e6e3f0;border-radius:10px;vertical-align:top;width:33%">
      <div style="font-size:11px;color:#777;text-transform:uppercase;letter-spacing:.04em">${label}</div>
      <div style="font-size:20px;font-weight:700;color:#1a1a2e;margin:4px 0">${value}</div>
      <div style="font-size:12px">${sub}</div>
    </td>`;
  const row = (a, b) => `<tr><td style="padding:6px 0;border-bottom:1px solid #f0eef6">${a}</td><td style="padding:6px 0;border-bottom:1px solid #f0eef6;text-align:right;white-space:nowrap">${b}</td></tr>`;
  const section = (title, body) => `<h3 style="font-size:14px;margin:26px 0 8px;color:#1a1a2e">${title}</h3>${body}`;
  const table = (rows) => `<table style="width:100%;border-collapse:collapse;font-size:13px;color:#333">${rows}</table>`;

  const wonTop = d.won.top.length ? section('Tratos ganados en la semana', table(d.won.top.map((w) => row(escapeHtml(w.title || 'Sin título'), usd(w.usd))).join(''))) : '';
  const debtors = d.overdue.top.length
    ? section('Quién más debe (vencido)', table(d.overdue.top.map((o) => row(`${escapeHtml(o.client)} <span style="color:#888">· ${o.invoices} factura${o.invoices === 1 ? '' : 's'} · hasta ${o.max_days} días</span>`, usd(o.usd))).join('')))
    : '';
  const act = d.activity && d.activity.rows?.length
    ? section(`Tratos sin actividad al día (${d.activity.total_pending} de ${d.activity.total_open} abiertos)`,
      table(d.activity.rows.filter((r) => r.pending > 0).slice(0, 10).map((r) => row(escapeHtml(r.name), `<b>${r.pending}</b> de ${r.open} <span style="color:#888">· ${r.none} sin agendar · ${r.late} vencidas</span>`)).join('')))
    : '';

  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a2e;max-width:640px;margin:0 auto">
    <div style="background:linear-gradient(90deg,#8500FF,#E000FF);color:#fff;padding:18px 22px;border-radius:12px 12px 0 0">
      <div style="font-size:12px;opacity:.85">Bit CRM · resumen semanal</div>
      <div style="font-size:20px;font-weight:700">Semana del ${fmtRange(d.week)}</div>
    </div>
    <div style="border:1px solid #e6e3f0;border-top:0;border-radius:0 0 12px 12px;padding:20px 22px">
      <p style="margin:0 0 16px;font-size:14px">Hola${name ? ` ${escapeHtml(name.split(' ')[0])}` : ''}, así cerró la semana. Todo en USD a la tasa de hoy.</p>
      <table style="width:100%;border-collapse:separate;border-spacing:8px 8px;margin:0 -8px"><tr>
        ${card('Ganado', usd(d.won.usd), `${d.won.count} trato${d.won.count === 1 ? '' : 's'}<br>${delta(d.won.usd, d.won.prev_usd)}`)}
        ${card('Facturado', usd(d.invoiced.usd), `${d.invoiced.count} factura${d.invoiced.count === 1 ? '' : 's'}<br>${delta(d.invoiced.usd, d.invoiced.prev_usd)}`)}
        ${card('Cobrado', usd(d.collected.usd), delta(d.collected.usd, d.collected.prev_usd))}
      </tr><tr>
        ${card('Por cobrar hoy', usd(d.receivable_usd))}
        ${card('Vencido hoy', `<span style="color:${d.overdue.usd > 0 ? '#c0392b' : '#1a1a2e'}">${usd(d.overdue.usd)}</span>`, `${d.overdue.count} factura${d.overdue.count === 1 ? '' : 's'}`)}
        ${card('Pipeline', `${d.new_deals.count} nuevos`, `${usd(d.new_deals.usd)} · ${d.lost_count} perdido${d.lost_count === 1 ? '' : 's'}`)}
      </tr></table>
      ${wonTop}${debtors}${act}
      <p style="margin:26px 0 6px">
        <a href="${CRM_URL}/metrics" style="background:linear-gradient(90deg,#8500FF,#E000FF);color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block;font-size:14px">Abrir Métricas</a>
        <a href="${CRM_URL}/invoicing?status=vencida" style="color:#8500FF;padding:10px 14px;text-decoration:none;display:inline-block;font-size:14px">Ver facturas vencidas</a>
      </p>
      <p style="color:#999;font-size:11px;margin:14px 0 0">«Cobrado» cuenta los pagos registrados con fecha en la semana. Recibes este correo cada lunes por ser admin con acceso a Facturación.</p>
    </div>
  </div>`;
}

async function loadWeeklyDigest(today = todayInTz()) {
  const { prev } = weekRanges(today);
  const since = `${fromDay(toDay(prev.from) - DAY)}T00:00:00Z`; // un día de margen por zona horaria
  const [won, lost, created, inv, pay, rates, activityHealth] = await Promise.all([
    fetchAll(supabase.from('deals').select('id, title, value, currency, status, closed_at, created_at').eq('status', 'ganado').gte('closed_at', since)),
    fetchAll(supabase.from('deals').select('id, title, value, currency, status, closed_at, created_at').eq('status', 'perdido').gte('closed_at', since)),
    fetchAll(supabase.from('deals').select('id, title, value, currency, status, closed_at, created_at').gte('created_at', since)),
    fetchAll(supabase.from('invoices').select('id, client_name, total, paid_amount, currency, status, issue_date, due_date, companies(name)').neq('status', 'cancelada')),
    fetchAll(supabase.from('invoice_payments').select('id, amount, paid_at, invoices(currency)').gte('paid_at', since)),
    supabase.from('exchange_rates').select('*'),
    loadActivityHealth().catch(() => null),
  ]);
  const failed = [won, lost, created, inv, pay].find((r) => r.error);
  if (failed) throw new Error(failed.error.message);
  const deals = [...new Map([...(won.data || []), ...(lost.data || []), ...(created.data || [])].map((d) => [d.id, d])).values()];
  return computeWeeklyDigest({ today, deals, invoices: inv.data || [], payments: pay.data || [], rates: rates.data || [], activityHealth });
}

const subjectFor = (d) => `Resumen semanal · ${usd(d.won.usd)} ganado · ${usd(d.collected.usd)} cobrado · ${usd(d.overdue.usd)} vencido`;

// Envío a una persona (botón «Enviarme el resumen» y cada destinatario del envío automático)
async function sendDigestTo(member, digest) {
  return sendEmail({ to: member.email, subject: subjectFor(digest), html: renderDigestHtml(digest, member.full_name || '') });
}

// Automático: lunes desde las 8:00 (hora del negocio), una sola vez por semana y por persona.
async function runWeeklyDigest({ now = new Date() } = {}) {
  const today = dateInTz(now);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TZ, hour: 'numeric', hourCycle: 'h23' }).format(now));
  if (new Date(toDay(today)).getUTCDay() !== 1 || hour < 8) return { skipped: 'solo los lunes desde las 8:00' };

  const { data: admins } = await supabase.from('team_members').select('id, email, full_name, blocked_pages, active').eq('role', 'admin');
  const recipients = (admins || []).filter((a) => a.active !== false && a.email && !(a.blocked_pages || []).includes('facturacion'));
  if (!recipients.length) return { sent: 0 };

  const startOfDay = `${today}T05:00:00Z`; // 00:00 en Panamá (UTC-5)
  let digest = null, sent = 0;
  for (const a of recipients) {
    const { data: already } = await supabase.from('notifications').select('id').eq('recipient_id', a.id).eq('type', 'weekly_digest').gte('created_at', startOfDay).limit(1);
    if (already && already.length) continue;
    if (!digest) digest = await loadWeeklyDigest(today);
    // Primero la marca (notificación en la app): si el correo falla no se reintenta cada 15 min todo el día.
    await createNotification({
      recipient_id: a.id, type: 'weekly_digest',
      title: `Resumen semanal: ${usd(digest.won.usd)} ganado · ${usd(digest.collected.usd)} cobrado`,
      body: `${usd(digest.overdue.usd)} vencido en ${digest.overdue.count} facturas. También te llegó por correo.`,
      link: '/metrics',
    });
    const r = await sendDigestTo(a, digest);
    if (r.ok) sent++; else console.error(`[weekly-digest] no se pudo enviar a ${a.email}: ${r.error}`);
  }
  return { sent, recipients: recipients.length };
}

module.exports = { weekRanges, computeWeeklyDigest, renderDigestHtml, loadWeeklyDigest, sendDigestTo, runWeeklyDigest, subjectFor };
