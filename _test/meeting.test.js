// Link de reunión: limpieza, envío al evento de Google Calendar y tolerancia a la columna faltante.
const Module = require('module'); const path = require('path');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const captured = [];
const googleStub = { google: { auth: { OAuth2: class { setCredentials() { } } }, calendar: () => ({ events: { insert: async ({ requestBody }) => { captured.push(requestBody); return { data: { id: 'ev1', htmlLink: 'https://cal/ev1' } }; }, update: async ({ requestBody }) => { captured.push(requestBody); return { data: { id: 'ev1', htmlLink: 'https://cal/ev1' } }; }, delete: async () => ({}) } }) } };
function Q(result) { const chain = new Proxy({}, { get: (t, k) => (k === 'then' ? (res) => res(result()) : () => chain) }); return chain; }
const origLoad = Module._load;
Module._load = function (request) {
  if (/config\/supabase$/.test(request)) return { from: (t) => Q(() => (t === 'gmail_connections' ? { data: { refresh_token: 'r', email: 'mario@bitproximity.com' }, error: null } : { data: null, error: null })) };
  if (request === 'googleapis') return googleStub;
  return origLoad.apply(this, arguments);
};
process.env.GOOGLE_CLIENT_ID = 'x'; process.env.GOOGLE_CLIENT_SECRET = 'x'; process.env.GOOGLE_REDIRECT_URI = 'http://x'; process.env.SUPABASE_URL = 'http://x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
const { cleanMeetingUrl, meetingProvider, withMeetingUrlFallback } = require('../src/utils/meetingUrl');
const { syncTaskToCalendar, syncActivityToCalendar } = require('../src/utils/googleCalendarSync');
(async () => {
  ok(cleanMeetingUrl('https://meet.google.com/abc-defg-hij') === 'https://meet.google.com/abc-defg-hij', 'link https válido se conserva');
  ok(cleanMeetingUrl('  meet.google.com/abc-defg-hij ') === 'https://meet.google.com/abc-defg-hij', 'sin https:// se completa y se recortan espacios');
  ok(cleanMeetingUrl('javascript:alert(1)') === null && cleanMeetingUrl('data:text/html,x') === null && cleanMeetingUrl('ftp://x.com/a') === null, 'esquemas peligrosos (javascript:, data:, ftp:) se descartan');
  ok(cleanMeetingUrl('') === null && cleanMeetingUrl(null) === null && cleanMeetingUrl('hola que tal') === null, 'vacío o texto suelto → null');
  ok(meetingProvider('https://meet.google.com/x') === 'Google Meet' && meetingProvider('https://us02web.zoom.us/j/123') === 'Zoom' && meetingProvider('https://teams.microsoft.com/l/x') === 'Microsoft Teams' && meetingProvider('https://miempresa.com/sala') === null, 'reconoce Meet, Zoom y Teams');

  const due = new Date(Date.now() + 86400000).toISOString();
  let r = await syncTaskToCalendar({ id: 't1', title: 'Reunion Spoonity', assignee_id: 'u1', due_date: due, status: 'pendiente', meeting_url: 'https://us02web.zoom.us/j/123456' });
  let ev = captured.pop();
  ok(r.ok && ev.location === 'https://us02web.zoom.us/j/123456', 'tarea con link: el evento lleva el link en «Ubicación»');
  ok(/Unirse a Zoom: https:\/\/us02web\.zoom\.us\/j\/123456/.test(ev.description), 'y en la descripción, con el nombre del servicio');
  r = await syncTaskToCalendar({ id: 't2', title: 'Sin link', assignee_id: 'u1', due_date: due, status: 'pendiente' });
  ev = captured.pop(); ok(r.ok && !('location' in ev) && !/Unirse|Link de la reunión/.test(ev.description), 'tarea sin link: el evento queda como siempre');
  r = await syncTaskToCalendar({ id: 't3', title: 'Link malo', assignee_id: 'u1', due_date: due, status: 'pendiente', meeting_url: 'javascript:alert(1)' });
  ev = captured.pop(); ok(!('location' in ev), 'un link inválido guardado por error NO llega a Google Calendar');
  r = await syncActivityToCalendar({ id: 'a1', title: 'Demo', type: 'reunion', author_id: 'u1', due_date: due, done: false, meeting_url: 'meet.google.com/abc-defg-hij' });
  ev = captured.pop(); ok(r.ok && ev.location === 'https://meet.google.com/abc-defg-hij' && /Unirse a Google Meet/.test(ev.description), 'actividad (reunión) con link: ubicación y descripción');

  // columna faltante: reintenta sin meeting_url en vez de fallar
  const seen = [];
  const run = async (p) => { seen.push({ ...p }); return 'meeting_url' in p ? { data: null, error: { message: "Could not find the 'meeting_url' column of 'tasks' in the schema cache" } } : { data: { id: 'ok' }, error: null }; };
  const out = await withMeetingUrlFallback(run, { title: 'x', meeting_url: 'https://a.com' });
  ok(!out.error && out.data.id === 'ok' && out.meetingUrlSkipped && seen.length === 2 && !('meeting_url' in seen[1]), 'si falta la columna, guarda la tarea igual (sin el link) en vez de dar error');
  const out2 = await withMeetingUrlFallback(async () => ({ data: null, error: { message: 'otro error real' } }), { title: 'x', meeting_url: 'https://a.com' });
  ok(out2.error && out2.error.message === 'otro error real', 'otros errores NO se esconden');
})();
