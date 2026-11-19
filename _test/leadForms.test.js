// Formularios de captura: plantilla Bit Music, validación, asociar al trato existente y métricas.
process.env.SUPABASE_URL = 'http://x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
const Module = require('module'); const path = require('path'); const http = require('http');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const { createFakeDb, install } = require('./fakeSupabase');
const kit = require('../src/utils/leadFormKit');

// ── Utilidades puras ──
const s = kit.normalizeSettings({ title: '  Hola  ', theme: { primary: '#AA00FF', background: 'red;}', logo_url: 'javascript:alert(1)' }, labels: { company: 'Marca', otro: 'x' }, long_field_ids: ['a', 3] });
ok(s.title === 'Hola' && s.theme.primary === '#AA00FF' && !s.theme.background && !s.theme.logo_url, 'los ajustes solo aceptan colores hex y logos https (nada que inyecte CSS o JS en la página pública)');
ok(s.labels.company === 'Marca' && !s.labels.otro && s.long_field_ids.length === 1 && s.match_existing === true, 'etiquetas conocidas, listas limpias y «asociar al trato existente» activo por defecto');
ok(kit.dealTitleFor({ deal_title: '{company} · Bit Music' }, { name: 'Ana', company: 'Toks' }) === 'Toks · Bit Music' && kit.dealTitleFor({}, { name: 'Ana', company: '' }) === 'Lead: Ana', 'título del trato nuevo desde la plantilla');
const pick = kit.pickExistingDeal([
  { id: 'won-old', status: 'ganado', created_at: '2026-01-01' }, { id: 'won-new', status: 'ganado', created_at: '2026-06-01' },
  { id: 'lost', status: 'perdido', created_at: '2026-10-01' },
]);
ok(pick.id === 'won-new' && kit.pickExistingDeal([{ id: 'l', status: 'perdido' }]) === null && kit.pickExistingDeal([{ id: 'w', status: 'ganado', created_at: '2026-09-01' }, { id: 'o', status: 'abierto', created_at: '2026-01-01' }]).id === 'o', 'prefiere el trato abierto, luego el ganado más reciente; un perdido no se reabre');

const m = kit.computeFormMetrics({
  today: '2026-11-18',
  fields: [{ id: 'n', label: 'Puntos', field_type: 'number' }, { id: 'y', label: 'Anuncios', field_type: 'select' }, { id: 't', label: 'Artistas', field_type: 'text' }],
  deals: [{ id: 'd1', status: 'ganado' }, { id: 'd2', status: 'perdido' }, { id: 'd3', status: 'abierto' }],
  submissions: [
    { created_at: '2026-11-18T15:00:00Z', deal_id: 'd1', matched_existing: true, answers: { custom: { n: '10', y: 'Sí', t: 'Coldplay' } } },
    { created_at: '2026-11-13T15:00:00Z', deal_id: 'd2', matched_existing: false, answers: { custom: { n: '4', y: 'No' } } },
    { created_at: '2026-10-01T15:00:00Z', deal_id: 'd3', matched_existing: false, answers: { custom: { y: 'Sí' } } },
  ],
});
ok(m.total === 3 && m.last_7_days === 2 && m.last_30_days === 2 && m.weeks.length === 12 && m.weeks[11].count === 1 && m.weeks[10].count === 1, 'envíos totales, últimos 7/30 días y por semana');
ok(m.new_deals === 2 && m.attached_to_existing === 1 && m.deals.ganado === 1 && m.deals.win_rate_pct === 50, 'tratos nuevos vs asociados y tasa de cierre de los tratos que vinieron del formulario');
ok(m.questions[0].stats.sum === 14 && m.questions[0].stats.avg === 7 && m.questions[1].distribution[0].value === 'Sí' && m.questions[1].distribution[0].pct === 67 && m.questions[2].answered_pct === 33, 'métricas por pregunta: números (suma/promedio), opciones (reparto) y texto (% que respondió)');

// ── Rutas con base simulada ──
const fake = createFakeDb({
  pipelines: [{ id: 'p-music', name: 'Bit Music', pipeline_stages: [{ id: 'st-2', name: 'Contactado', position: 2 }, { id: 'st-1', name: 'Prospecto', position: 1 }] }],
  team_members: [{ id: 'u-admin', email: 'mario@x.com', role: 'admin', active: true }, { id: 'u-ana', email: 'ana@x.com', role: 'vendedor', active: true }],
  custom_field_definitions: [], custom_field_values: [], lead_forms: [], lead_form_submissions: [],
  companies: [{ id: 'co-toks', name: 'Toks' }],
  contacts: [{ id: 'ct-ana', first_name: 'Ana', email: 'ana@toks.mx', phone: null, company_id: null }],
  deals: [{ id: 'd-toks', title: 'Toks · Bit Music', status: 'ganado', pipeline_id: 'p-music', contact_id: 'ct-other', company_id: 'co-toks', owner_id: 'u-ana', created_at: '2026-09-01' }],
  activities: [], notifications: [],
});
install(fake);
const sent = [];
const origLoad = Module._load;
Module._load = function (request) {
  if (/utils\/email$/.test(request)) return { sendEmail: async (m) => { sent.push(m); return { ok: true }; } };
  if (/utils\/notify$/.test(request)) return { createNotification: async (n) => { fake.db.notifications.push(n); } };
  return origLoad.apply(this, arguments);
};
const express = require(path.resolve(__dirname, '../node_modules/express'));
const app = express(); app.use(express.json());
app.use('/api/public/lead-forms', require('../src/routes/publicLeadForms'));
app.use('/api/lead-forms', require('../src/routes/leadForms'));

const srv = app.listen(0, async () => {
  const call = (method, p, body) => new Promise((r) => {
    const req = http.request({ port: srv.address().port, path: p, method, headers: { 'content-type': 'application/json' } }, (res) => { let t = ''; res.on('data', (c) => t += c); res.on('end', () => r({ status: res.statusCode, body: t ? JSON.parse(t) : null })); });
    if (body) req.write(JSON.stringify(body)); req.end();
  });
  const wait = () => new Promise((r) => setTimeout(r, 30));

  let r = await call('POST', '/api/lead-forms/templates/bitmusic');
  const form = r.body;
  ok(r.status === 201 && form.pipeline_id === 'p-music' && form.stage_id === 'st-1' && form.field_ids.length === 9, 'la plantilla crea el formulario en Bit Music → Prospecto con sus 9 preguntas');
  const defs = fake.db.custom_field_definitions;
  ok(defs.length === 9 && defs.every((d) => d.entity_type === 'deal') && defs.find((d) => d.key === 'bm_anuncios_propios').options.join() === 'Sí,No', 'las preguntas quedan como campos del trato (Sí/No como opciones)');
  ok(form.settings.theme.logo_url.startsWith('https://bitmusicapp.com/') && form.settings.theme.secondary === '#E000FF' && form.settings.long_field_ids.length === 7 && form.settings.required_field_ids.length === 2, 'trae logo y colores de Bit Music, respuestas largas y obligatorias');
  r = await call('POST', '/api/lead-forms/templates/bitmusic');
  ok(r.status === 200 && r.body.already_existed && fake.db.lead_forms.length === 1 && fake.db.custom_field_definitions.length === 9, 'usar la plantilla otra vez no duplica nada');

  r = await call('GET', `/api/public/lead-forms/${form.id}`);
  ok(r.body.settings.title === 'Musicalizamos espacios comerciales' && r.body.settings.theme.brand_name === 'Bit Music' && r.body.custom_fields[5].hint.startsWith('Ejemplo') && r.body.custom_fields[0].required && !r.body.settings.match_existing && !r.body.settings.product_line, 'la página pública recibe textos, marca y pistas, pero no la configuración interna');

  const id = (k) => defs.find((d) => d.key === k).id;
  r = await call('POST', `/api/public/lead-forms/${form.id}/submit`, { name: 'Luis Paz', email: 'luis@pollo.co', company: 'Pollo Feliz', custom_answers: { [id('bm_puntos_de_venta')]: '12' } });
  ok(r.status === 400 && /Falta responder: ¿En qué países/.test(r.body.error), 'si falta una pregunta obligatoria, dice cuál');
  r = await call('POST', `/api/public/lead-forms/${form.id}/submit`, { name: 'Luis Paz', company: 'Pollo Feliz' });
  ok(r.status === 400 && /Correo electrónico/.test(r.body.error), 'el correo es obligatorio en esta plantilla y el aviso usa su etiqueta');

  // Cliente nuevo → trato nuevo
  r = await call('POST', `/api/public/lead-forms/${form.id}/submit`, { name: 'Luis Paz', email: 'luis@pollo.co', phone: '+57 300', company: 'Pollo Feliz', custom_answers: { [id('bm_puntos_de_venta')]: '12', [id('bm_paises_ciudades')]: 'Bogotá, Medellín', [id('bm_anuncios_propios')]: 'Sí', 'campo-ajeno': 'x' } });
  await wait();
  const newDeal = fake.db.deals.find((d) => d.title === 'Pollo Feliz · Bit Music');
  ok(r.status === 201 && newDeal && newDeal.pipeline_id === 'p-music' && newDeal.stage_id === 'st-1' && newDeal.product_line === 'Bit Music', 'cliente nuevo: crea el trato en Bit Music con producto Bit Music');
  ok(fake.db.custom_field_values.filter((v) => v.entity_id === newDeal.id).length === 3 && !fake.db.custom_field_values.some((v) => v.field_id === 'campo-ajeno'), 'guarda las respuestas en el trato (e ignora campos que no son del formulario)');
  let sub = fake.db.lead_form_submissions[0];
  ok(sub && sub.deal_id === newDeal.id && sub.matched_existing === false && sub.answers.company === 'Pollo Feliz' && sub.answers.custom[id('bm_anuncios_propios')] === 'Sí', 'el envío queda registrado para las métricas');
  ok(sent.some((e) => e.to === 'mario@x.com' && /Nuevo lead/.test(e.subject)), 'sin dueño de formulario, avisa a los admin');

  // Cliente que ya tiene trato ganado (por la empresa) → se asocia, no se duplica
  const dealsBefore = fake.db.deals.length; sent.length = 0;
  r = await call('POST', `/api/public/lead-forms/${form.id}/submit`, { name: 'Ana Ruiz', email: 'ANA@toks.mx', phone: '+52 55', company: 'toks', custom_answers: { [id('bm_puntos_de_venta')]: '180', [id('bm_paises_ciudades')]: 'México', [id('bm_artistas')]: 'Shakira, Juanes, Bad Bunny, Karol G, Maná' } });
  await wait();
  ok(r.status === 201 && fake.db.deals.length === dealsBefore, 'cliente con trato en Bit Music: no crea un trato duplicado');
  ok(fake.db.custom_field_values.filter((v) => v.entity_id === 'd-toks').length === 3, 'las respuestas quedan en su trato existente');
  const note = fake.db.activities.find((a) => a.entity_id === 'd-toks');
  ok(note && /Respuestas del formulario/.test(note.title) && /Bad Bunny/.test(note.summary), 'deja una nota en el trato con todas las respuestas');
  ok(fake.db.contacts.find((c) => c.id === 'ct-ana').phone === '+52 55' && fake.db.contacts.find((c) => c.id === 'ct-ana').company_id === 'co-toks', 'completa el teléfono y la empresa que le faltaban al contacto');
  ok(sent.length === 1 && sent[0].to === 'ana@x.com' && /Respuesta de cliente/.test(sent[0].subject), 'avisa al responsable de ese trato');
  sub = fake.db.lead_form_submissions[1];
  ok(sub.deal_id === 'd-toks' && sub.matched_existing === true, 'el envío queda marcado como «asociado a trato existente»');

  // Mismo cliente lo vuelve a llenar → actualiza, no repite valores
  await call('POST', `/api/public/lead-forms/${form.id}/submit`, { name: 'Ana Ruiz', email: 'ana@toks.mx', company: 'Toks', custom_answers: { [id('bm_puntos_de_venta')]: '190', [id('bm_paises_ciudades')]: 'México' } });
  await wait();
  const pv = fake.db.custom_field_values.filter((v) => v.entity_id === 'd-toks' && v.field_id === id('bm_puntos_de_venta'));
  ok(pv.length === 1 && pv[0].value === '190', 'si responde de nuevo, actualiza la respuesta en vez de duplicarla');

  // Métricas y respuestas
  r = await call('GET', `/api/lead-forms/${form.id}/responses`);
  ok(r.status === 200 && r.body.metrics.total === 3 && r.body.metrics.new_deals === 1 && r.body.metrics.attached_to_existing === 2 && r.body.rows.length === 3 && r.body.fields.length === 9, 'el panel recibe métricas, preguntas y cada respuesta');
  const pts = r.body.metrics.questions.find((q) => q.id === id('bm_puntos_de_venta'));
  ok(pts.stats.sum === 202 && r.body.rows.some((x) => x.deal && x.deal.status === 'ganado'), 'suma de puntos de venta y estado del trato de cada respuesta');

  // Edición: solo campos permitidos y ajustes saneados
  r = await call('PATCH', `/api/lead-forms/${form.id}`, { submissions_count: 999, settings: { ...form.settings, title: 'Nuevo', theme: { ...form.settings.theme, primary: 'url(x)' } } });
  ok(r.status === 200 && r.body.submissions_count !== 999 && r.body.settings.title === 'Nuevo' && !r.body.settings.theme.primary && r.body.settings.theme.secondary === '#E000FF', 'editar no deja tocar el contador y limpia los ajustes');

  // Sin la tabla de envíos (script 066 sin correr), el formulario sigue funcionando
  fake.failTables.add('lead_form_submissions');
  r = await call('POST', `/api/public/lead-forms/${form.id}/submit`, { name: 'Eva', email: 'eva@cafe.co', company: 'Café Uno', custom_answers: { [id('bm_puntos_de_venta')]: '2', [id('bm_paises_ciudades')]: 'Lima' } });
  ok(r.status === 201 && fake.db.deals.some((d) => d.title === 'Café Uno · Bit Music'), 'si falta la tabla de respuestas, el envío igual crea el trato');
  r = await call('GET', `/api/lead-forms/${form.id}/responses`);
  ok(r.status === 409 && /066/.test(r.body.error), 'y el panel avisa que falta correr el script 066');

  srv.close();
});
