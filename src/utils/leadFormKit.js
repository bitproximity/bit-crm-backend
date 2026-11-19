// Formularios de captura: ajustes por formulario (textos, marca, preguntas largas/obligatorias),
// cómo se asocia un envío a un trato que ya existe, la plantilla de Bit Music y las métricas
// de respuestas. Separado de las rutas para poder probarlo sin servidor.

const clipStr = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const HEX = /^#[0-9a-f]{6}$/i;
const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 60) : []);

// Solo lo que se reconoce y con largo acotado: esto lo edita un admin pero se pinta en una página pública.
function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const labels = s.labels && typeof s.labels === 'object' ? s.labels : {};
  const req = s.required && typeof s.required === 'object' ? s.required : {};
  const theme = s.theme && typeof s.theme === 'object' ? s.theme : {};
  const hints = s.hints && typeof s.hints === 'object' ? s.hints : {};
  const logo = clipStr(theme.logo_url, 500);
  return {
    title: clipStr(s.title, 160),
    description: clipStr(s.description, 600),
    thank_you: clipStr(s.thank_you, 400),
    submit_label: clipStr(s.submit_label, 40),
    labels: Object.fromEntries(['name', 'email', 'phone', 'company', 'message'].map((k) => [k, clipStr(labels[k], 200)]).filter(([, v]) => v)),
    required: { email: !!req.email, phone: !!req.phone, company: !!req.company },
    hide_message: !!s.hide_message,
    long_field_ids: ids(s.long_field_ids),
    required_field_ids: ids(s.required_field_ids),
    hints: Object.fromEntries(Object.entries(hints).slice(0, 60).map(([k, v]) => [k, clipStr(v, 300)]).filter(([, v]) => v)),
    match_existing: s.match_existing !== false,
    product_line: clipStr(s.product_line, 60),
    deal_title: clipStr(s.deal_title, 120),
    theme: {
      ...(HEX.test(theme.primary || '') ? { primary: theme.primary } : {}),
      ...(HEX.test(theme.secondary || '') ? { secondary: theme.secondary } : {}),
      ...(HEX.test(theme.accent || '') ? { accent: theme.accent } : {}),
      ...(HEX.test(theme.background || '') ? { background: theme.background } : {}),
      ...(HEX.test(theme.card || '') ? { card: theme.card } : {}),
      ...(/^https:\/\/[^\s"'<>]+$/i.test(logo) || /^\/(?!\/)[\w\-./]+$/.test(logo) ? { logo_url: logo } : {}),
      ...(clipStr(theme.brand_name, 60) ? { brand_name: clipStr(theme.brand_name, 60) } : {}),
    },
  };
}

// Título del trato nuevo: «{company} · Bit Music» → «Pollo Tropical · Bit Music».
function dealTitleFor(settings, { name, company }) {
  const tpl = settings?.deal_title;
  if (!tpl) return `Lead: ${company || name}`;
  return tpl.replace(/\{company\}/g, company || name).replace(/\{name\}/g, name).slice(0, 200);
}

// Trato al que se pega la respuesta: el abierto más reciente del mismo embudo (del contacto y, si no
// hay, de la empresa); si no hay abierto, el ganado más reciente (un cliente nuevo que llena su
// brief). Un trato perdido no se reabre: se crea uno nuevo.
function pickExistingDeal(deals) {
  const byNewest = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));
  const open = (deals || []).filter((d) => d.status === 'abierto').sort(byNewest);
  if (open.length) return open[0];
  const won = (deals || []).filter((d) => d.status === 'ganado').sort(byNewest);
  return won[0] || null;
}

// Plantilla: réplica del formulario «Musicalizamos espacios comerciales» de forms.app.
const BIT_MUSIC_TEMPLATE = {
  key: 'bitmusic',
  slug: 'bitmusic',
  name: 'Bit Music · Perfil musical de la marca',
  pipeline_name: 'Bit Music',
  stage_name: 'Prospecto',
  fields: [
    { key: 'bm_puntos_de_venta', label: '¿Cuántos puntos de venta tienen?', field_type: 'number', required: true },
    { key: 'bm_paises_ciudades', label: '¿En qué países o ciudades tienen presencia?', field_type: 'text', long: true, required: true },
    { key: 'bm_tipo_musica', label: '¿Qué tipo de música quisieras en tus tiendas?', field_type: 'text', long: true },
    { key: 'bm_target_cliente', label: '¿Qué target de cliente tienen definido?', field_type: 'text', long: true },
    { key: 'bm_genero_marca', label: '¿A qué género está orientada la marca?', field_type: 'text', long: true },
    { key: 'bm_perfil_cliente_ideal', label: 'Describe brevemente el perfil de tu cliente ideal', field_type: 'text', long: true, hint: 'Ejemplo: fanático de la música pop, muy activo en redes sociales y al día con las últimas tendencias. Juvenil, extrovertido…' },
    { key: 'bm_sensaciones', label: '¿Qué sensación o sensaciones quieren generar en sus clientes?', field_type: 'text', long: true, hint: 'Ejemplo: energía, diversión, chill.' },
    { key: 'bm_artistas', label: '¿Qué artistas se identifican con la marca? (mínimo 5)', field_type: 'text', long: true },
    { key: 'bm_anuncios_propios', label: '¿Quisieras incluir tus propios anuncios comerciales?', field_type: 'select', options: ['Sí', 'No'] },
  ],
  settings: {
    title: 'Musicalizamos espacios comerciales',
    description: 'Cuéntanos sobre tu marca y tus clientes. Con estas respuestas diseñamos la música de tus puntos de venta.',
    thank_you: 'Con esta información armamos la propuesta musical de tu marca y te contactamos muy pronto.',
    submit_label: 'Enviar',
    labels: { name: 'Nombre completo', email: 'Correo electrónico', phone: 'Número de teléfono', company: '¿Cuál es el nombre de tu marca?' },
    required: { email: true, phone: false, company: true },
    hide_message: true,
    match_existing: true,
    product_line: 'Bit Music',
    deal_title: '{company} · Bit Music',
    theme: {
      brand_name: 'Bit Music',
      logo_url: '/brands/bitmusic-logo.png',   // logo oficial, servido por el propio CRM
      primary: '#8000FF',
      secondary: '#E600FF',
      accent: '#D3EEF8',
      background: '#151A33',
      card: '#1F2648',
    },
  },
};
const TEMPLATES = { bitmusic: BIT_MUSIC_TEMPLATE };

// Métricas de un formulario a partir de sus envíos guardados.
// submissions: [{ created_at, deal_id, matched_existing, answers: { name, email, phone, company, custom: { field_id: valor } } }]
// deals: [{ id, status, title }]   fields: definiciones de los campos del formulario   today: 'YYYY-MM-DD'
function computeFormMetrics({ submissions, deals, fields, today }) {
  const subs = submissions || [];
  const dealById = new Map((deals || []).map((d) => [d.id, d]));
  const dayMs = 86400000;
  const t = new Date(`${today}T00:00:00Z`).getTime();
  const since = (n) => subs.filter((s) => new Date(s.created_at).getTime() >= t - (n - 1) * dayMs).length;

  // Últimas 12 semanas (de lunes a domingo), la más antigua primero.
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  const thisMonday = t - dow * dayMs;
  const weeks = Array.from({ length: 12 }, (_, i) => {
    const from = thisMonday - (11 - i) * 7 * dayMs;
    const to = from + 7 * dayMs;
    return { week: new Date(from).toISOString().slice(0, 10), count: subs.filter((s) => { const x = new Date(s.created_at).getTime(); return x >= from && x < to; }).length };
  });

  const dealIds = [...new Set(subs.map((s) => s.deal_id).filter(Boolean))];
  const st = { abierto: 0, ganado: 0, perdido: 0 };
  for (const id of dealIds) { const d = dealById.get(id); if (d && st[d.status] != null) st[d.status] += 1; }
  const closed = st.ganado + st.perdido;

  // Por pregunta cuenta la ÚLTIMA respuesta de cada cliente (trato): si alguien llena el formulario
  // dos veces, sus puntos de venta no se suman dos veces.
  const latest = new Map();
  for (const s of [...subs].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) latest.set(s.deal_id || `sub-${s.id || Math.random()}`, s);
  const base = [...latest.values()];
  const questions = (fields || []).map((f) => {
    const vals = base.map((s) => s.answers?.custom?.[f.id]).filter((v) => v != null && String(v).trim() !== '');
    const q = { id: f.id, label: f.label, field_type: f.field_type, answered: vals.length, answered_pct: base.length ? Math.round((100 * vals.length) / base.length) : 0 };
    if (f.field_type === 'select' || f.field_type === 'boolean') {
      const counts = {};
      for (const v of vals) counts[v] = (counts[v] || 0) + 1;
      q.distribution = Object.entries(counts).map(([value, count]) => ({ value, count, pct: Math.round((100 * count) / vals.length) })).sort((a, b) => b.count - a.count);
    } else if (f.field_type === 'number') {
      const nums = vals.map((v) => Number(String(v).replace(',', '.'))).filter((n) => Number.isFinite(n));
      if (nums.length) {
        const sum = nums.reduce((a, b) => a + b, 0);
        q.stats = { sum, avg: Math.round((sum / nums.length) * 10) / 10, min: Math.min(...nums), max: Math.max(...nums) };
      }
    }
    return q;
  });

  return {
    total: subs.length,
    clients: base.length,
    last_7_days: since(7),
    last_30_days: since(30),
    weeks,
    new_deals: subs.filter((s) => s.deal_id && !s.matched_existing).length,
    attached_to_existing: subs.filter((s) => s.matched_existing).length,
    deals: { ...st, total: dealIds.length, win_rate_pct: closed ? Math.round((100 * st.ganado) / closed) : null },
    questions,
  };
}

module.exports = { normalizeSettings, dealTitleFor, pickExistingDeal, computeFormMetrics, TEMPLATES, BIT_MUSIC_TEMPLATE };

// ── Link corto (slug) y link personalizado por trato ──
const crypto = require('crypto');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESERVED_SLUGS = new Set(['lead-forms', 'b2b', 'f', 'assets', 'brands', 'api']);

// «Bit Music Brief!» → «bit-music-brief». Devuelve '' si no queda nada usable.
function slugify(v) {
  return String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
function validSlug(v) {
  return typeof v === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(v) && !RESERVED_SLUGS.has(v) && !UUID_RE.test(v);
}

// Firma del link de un trato: nadie puede inventar el de otro trato cambiando el id.
const secret = () => process.env.LEAD_LINK_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'bit-crm';
function signDealToken(formId, dealId) {
  const sig = crypto.createHmac('sha256', secret()).update(`${formId}:${dealId}`).digest('base64url').slice(0, 22);
  return `${dealId}.${sig}`;
}
function verifyDealToken(formId, token) {
  if (typeof token !== 'string' || token.length > 120) return null;
  const [dealId, sig] = token.split('.');
  if (!dealId || !sig || !UUID_RE.test(dealId)) return null;
  const expected = signDealToken(formId, dealId).split('.')[1];
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? dealId : null;
}

module.exports.slugify = slugify;
module.exports.validSlug = validSlug;
module.exports.signDealToken = signDealToken;
module.exports.verifyDealToken = verifyDealToken;
module.exports.UUID_RE = UUID_RE;
