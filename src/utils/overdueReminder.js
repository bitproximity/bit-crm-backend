// Recordatorio de pago para una factura vencida + resumen diario de facturas vencidas.
const supabase = require('../config/supabase');
const { fetchAll } = require('./fetchAll');
const { todayInTz, dateInTz, BUSINESS_TZ } = require('./businessDate');
const { buildConverter, round2 } = require('./currency');
const { createNotification } = require('./notify');

const dayNum = (str) => { const [y, m, d] = String(str).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const money = (n, cur) => `${cur} ${Number(n || 0).toLocaleString('es', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d, lang) => new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString(lang === 'en' ? 'en-US' : 'es', { day: 'numeric', month: 'long', year: 'numeric' });

// Email del cliente: el que trae la factura (Stripe lo guarda en la nota), el contacto de la factura o
// el primer contacto con email de la empresa.
async function clientEmailFor(inv) {
  const fromNotes = /\(([^()\s]+@[^()\s]+)\)/.exec(inv.notes || '');
  if (fromNotes) return fromNotes[1];
  if (inv.contacts?.email) return inv.contacts.email;
  if (inv.company_id) {
    const { data } = await supabase.from('contacts').select('email').eq('company_id', inv.company_id).not('email', 'is', null).limit(1);
    if (data && data[0]?.email) return data[0].email;
  }
  return '';
}

function reminderText(inv, lang, daysLate) {
  const pending = Math.max(Number(inv.total || 0) - Number(inv.paid_amount || 0), 0);
  const who = inv.client_name || inv.companies?.name || '';
  const num = inv.invoice_number || '';
  if (lang === 'en') {
    return {
      subject: `Payment reminder — invoice ${num}`,
      body: `Hello${who ? ` ${who}` : ''},\n\nThis is a friendly reminder that invoice ${num} for ${money(pending, inv.currency)} was due on ${fmtDate(inv.due_date, 'en')} (${daysLate} day${daysLate === 1 ? '' : 's'} ago) and is still pending.\n\nIf you have already made the payment, please disregard this message or send us the receipt so we can update our records. If you need the invoice again or have any questions, just reply to this email.\n\nThank you,\nBit Proximity`,
    };
  }
  return {
    subject: `Recordatorio de pago — factura ${num}`,
    body: `Hola${who ? ` ${who}` : ''},\n\nTe escribimos para recordarte que la factura ${num} por ${money(pending, inv.currency)} venció el ${fmtDate(inv.due_date, 'es')} (hace ${daysLate} día${daysLate === 1 ? '' : 's'}) y sigue pendiente de pago.\n\nSi ya realizaste el pago, ignora este mensaje o envíanos el comprobante para actualizar nuestros registros. Si necesitas la factura de nuevo o tienes alguna duda, responde a este correo.\n\nGracias,\nBit Proximity`,
  };
}

async function buildReminder(invoiceId, lang = 'es') {
  const { data: inv, error } = await supabase.from('invoices').select('*, companies(name), contacts(email)').eq('id', invoiceId).single();
  if (error || !inv) { const e = new Error('Factura no encontrada'); e.status = 404; throw e; }
  const today = todayInTz();
  const daysLate = inv.due_date && inv.due_date < today ? Math.round(dayNum(today) - dayNum(inv.due_date)) : 0;
  const to = await clientEmailFor(inv);
  return { to, lang, days_late: daysLate, ...reminderText(inv, lang === 'en' ? 'en' : 'es', daysLate) };
}

// Una vez al día (desde las 8:00 de Panamá): una notificación a cada admin con acceso a Facturación con
// cuántas facturas están vencidas y cuánto suman en USD. No se repite el mismo día aunque el servidor reinicie.
async function runOverdueDigest({ now = new Date() } = {}) {
  const hourPty = Number(new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TZ, hour: 'numeric', hourCycle: 'h23' }).format(now));
  if (hourPty < 8) return { skipped: 'antes de las 8:00' };
  const today = dateInTz(now);

  const [{ data: invs, error }, { data: rates }, { data: admins }] = await Promise.all([
    fetchAll(supabase.from('invoices').select('id, total, paid_amount, currency, due_date, status').in('status', ['pendiente', 'parcial']).lt('due_date', today)),
    supabase.from('exchange_rates').select('*'),
    supabase.from('team_members').select('id, blocked_pages, active').eq('role', 'admin'),
  ]);
  if (error) return { error: error.message };
  const recipients = (admins || []).filter((a) => a.active !== false && !(a.blocked_pages || []).includes('facturacion'));
  if (!invs?.length || !recipients.length) return { overdue: invs?.length || 0, notified: 0 };

  const conv = buildConverter(rates);
  const totalUsd = round2(invs.reduce((n, i) => n + Math.max(conv.toUsd(i.total, i.currency) - conv.toUsd(i.paid_amount, i.currency), 0), 0));
  const startOfDay = new Date(`${today}T05:00:00Z`).toISOString(); // 00:00 en Panamá (UTC-5)

  let notified = 0;
  for (const a of recipients) {
    const { data: already } = await supabase.from('notifications').select('id').eq('recipient_id', a.id).eq('type', 'invoices_overdue').gte('created_at', startOfDay).limit(1);
    if (already && already.length) continue;
    await createNotification({
      recipient_id: a.id,
      type: 'invoices_overdue',
      title: `${invs.length} factura${invs.length === 1 ? '' : 's'} vencida${invs.length === 1 ? '' : 's'} · USD ${totalUsd.toLocaleString('es')}`,
      body: 'Ábrelas en Facturación → Vencidas y envía el recordatorio de pago desde cada una.',
      link: '/invoicing?status=vencida',
    });
    notified++;
  }
  return { overdue: invs.length, total_usd: totalUsd, notified };
}

module.exports = { buildReminder, runOverdueDigest, reminderText, clientEmailFor };
