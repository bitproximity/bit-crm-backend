// Validación de query string. Lo que no pasa por aquí no llega a Postgres.
const MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const DAYS_ERROR = 'days debe ser un entero entre 1 y 366.';

function parseFormat(value) {
  if (value === undefined || value === '') return { ok: true, format: 'json' };
  if (typeof value !== 'string') return { ok: false, error: 'format debe ser json o csv.' };
  if (value === 'json' || value === 'csv') return { ok: true, format: value };
  return { ok: false, error: 'format debe ser json o csv.' };
}

function parseDays(value) {
  if (value === undefined || value === '') return { ok: true, days: 30 };
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,2}$/.test(value)) return { ok: false, error: DAYS_ERROR };
  const days = Number(value);
  if (days < 1 || days > 366) return { ok: false, error: DAYS_ERROR };
  return { ok: true, days };
}

function parseMonthRange(from, to) {
  if (from !== undefined && typeof from !== 'string') return { ok: false, error: 'from debe ser un mes YYYY-MM.' };
  if (to !== undefined && typeof to !== 'string') return { ok: false, error: 'to debe ser un mes YYYY-MM.' };
  const fromMonth = from || null;
  const toMonth = to || null;
  if (fromMonth && !MONTH.test(fromMonth)) return { ok: false, error: 'from debe ser un mes YYYY-MM.' };
  if (toMonth && !MONTH.test(toMonth)) return { ok: false, error: 'to debe ser un mes YYYY-MM.' };
  if (fromMonth && toMonth && fromMonth > toMonth) return { ok: false, error: 'from no puede ser posterior a to.' };
  return { ok: true, from: fromMonth, to: toMonth };
}

// Primer día del mes siguiente. 2026-12 → 2027-01-01. El límite `to` es inclusivo.
function nextMonthStart(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-01`;
}

module.exports = { parseFormat, parseDays, parseMonthRange, nextMonthStart };
