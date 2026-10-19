// Link de reunión (Meet, Zoom, Teams…) de una tarea o actividad. Se guarda limpio y solo si es un
// enlace web real: nunca se guarda ni se envía a Google Calendar algo que no sea http(s).
function cleanMeetingUrl(value) {
  if (value == null) return null;
  let v = String(value).trim();
  if (!v) return null;
  // «meet.google.com/abc-defg-hij» pegado sin https:// → se completa
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v) && /^[\w-]+(\.[\w-]+)+(\/|$)/.test(v)) v = `https://${v}`;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch (e) {
    return null;
  }
}

// ¿Qué servicio es? (para mostrarlo con su nombre). null si es otro enlace.
function meetingProvider(url) {
  const h = (() => { try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; } })();
  if (/(^|\.)meet\.google\.com$/.test(h)) return 'Google Meet';
  if (/(^|\.)zoom\.(us|com)$/.test(h) || /\.zoom\.us$/.test(h)) return 'Zoom';
  if (/teams\.(microsoft|live)\.com$/.test(h)) return 'Microsoft Teams';
  if (/(^|\.)whereby\.com$/.test(h)) return 'Whereby';
  return null;
}

// Si la columna meeting_url todavía no existe en la base (falta correr la migración), el guardado no
// debe fallar: se reintenta sin ese campo.
const MISSING_COLUMN = /Could not find the 'meeting_url' column/i;
async function withMeetingUrlFallback(run, payload) {
  const first = await run(payload);
  if (first.error && MISSING_COLUMN.test(first.error.message || '') && 'meeting_url' in payload) {
    const { meeting_url, ...rest } = payload; // eslint-disable-line no-unused-vars
    const second = await run(rest);
    return { ...second, meetingUrlSkipped: true };
  }
  return first;
}

module.exports = { cleanMeetingUrl, meetingProvider, withMeetingUrlFallback };
