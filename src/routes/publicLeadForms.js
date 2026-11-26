const express = require('express');
const cors = require('cors');
const supabase = require('../config/supabase');
const { sendEmail } = require('../utils/email');
const { createNotification } = require('../utils/notify');
const { escapeHtml: h, escapeIlikeValue } = require('../utils/escape');
const { normalizeSettings, dealTitleFor, pickExistingDeal, matchPipelineIds, verifyDealToken, UUID_RE } = require('../utils/leadFormKit');

// El formulario se pide por su id o por su link corto (slug), p. ej. /public/bitmusic.
async function loadForm(key) {
  const k = String(key || '').slice(0, 80);
  if (!UUID_RE.test(k) && /^[a-z0-9-]+$/i.test(k)) {
    const { data, error } = await supabase.from('lead_forms').select('*').eq('slug', k.toLowerCase()).maybeSingle();
    if (!error && data) return data;
  }
  const { data, error } = await supabase.from('lead_forms').select('*').eq('id', k).maybeSingle();
  return error ? null : data;
}

// Link personalizado de un trato (?t=…): devuelve el trato con su contacto y empresa, o null.
async function dealFromToken(form, token) {
  const dealId = token ? verifyDealToken(form.id, token) : null;
  if (!dealId) return null;
  const { data } = await supabase.from('deals')
    .select('id, title, status, owner_id, contact_id, company_id, contacts(first_name, last_name, email, phone), companies(name)')
    .eq('id', dealId).maybeSingle();
  return data || null;
}

const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || 'https://crm.bitproximity.com';

const router = express.Router();

// Esta ruta se llama desde CUALQUIER sitio donde Mario incruste el formulario — no solo
// crm.bitproximity.com — así que necesita su propio CORS abierto, a diferencia del resto
// de la API (restringido a FRONTEND_ORIGIN). Es seguro: solo crea un contacto/trato con
// los campos que manda el visitante, nunca lee datos existentes.
router.use(cors({ origin: '*' }));

// GET /api/public/lead-forms/:id — datos mínimos para pintar el formulario (nombre, si
// está activo) + las preguntas extra configuradas (los mismos campos personalizados de
// "trato" que ya existen en Configuración, solo los elegidos para este formulario).
router.get('/:id', async (req, res) => {
  const data = await loadForm(req.params.id);
  if (!data) return res.status(404).json({ error: 'Formulario no encontrado.' });

  let custom_fields = [];
  if (data.field_ids?.length) {
    const { data: defs } = await supabase.from('custom_field_definitions').select('id, key, label, field_type, options').in('id', data.field_ids);
    // Respeta el orden en que Mario los eligió al armar el formulario, no el orden de la tabla.
    custom_fields = (data.field_ids || []).map((id) => defs?.find((d) => d.id === id)).filter(Boolean);
  }
  const settings = normalizeSettings(data.settings);
  custom_fields = custom_fields.map((f) => ({
    ...f,
    long: settings.long_field_ids.includes(f.id),
    required: settings.required_field_ids.includes(f.id),
    hint: settings.hints[f.id] || '',
  }));
  // Solo lo que la página pública necesita para pintarse (no el embudo, el dueño ni los conteos).
  const { long_field_ids, required_field_ids, hints, match_existing, match_pipeline_ids, product_line, deal_title, notify_emails, ...publicSettings } = settings;
  // Link personalizado: precarga lo que ya sabemos del cliente y lo que ya había respondido.
  let prefill = null;
  const deal = await dealFromToken(data, req.query.t);
  if (deal) {
    const c = deal.contacts || {};
    prefill = {
      name: [c.first_name, c.last_name].filter(Boolean).join(' '), email: c.email || '', phone: c.phone || '', company: deal.companies?.name || '',
      custom_answers: {},
    };
    if (data.field_ids?.length) {
      const { data: vals } = await supabase.from('custom_field_values').select('field_id, value').eq('entity_id', deal.id).in('field_id', data.field_ids);
      for (const v of vals || []) if (v.value != null && v.value !== '') prefill.custom_answers[v.field_id] = v.value;
    }
  }
  res.json({ id: data.id, slug: data.slug || null, name: data.name, active: data.active, custom_fields, settings: publicSettings, prefill });
});

// POST /api/public/lead-forms/:id/submit  { name, email?, phone?, company?, message?, custom_answers?: { field_id: value } }
// Lo que escribe un visitante anónimo se recorta y se valida: antes cualquier texto, de cualquier largo y tipo, llegaba tal cual a la
// base de datos y al correo de los administradores.
const clip = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

router.post('/:id/submit', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // Campo trampa (oculto para personas): si viene lleno, es un robot. Se responde «ok» sin crear nada, para que no sepa que fue detectado.
  if (typeof body.website === 'string' && body.website.trim() !== '') return res.status(201).json({ ok: true });

  const name = clip(body.name, 120);
  const email = clip(body.email, 200);
  const phone = clip(body.phone, 40);
  const company = clip(body.company, 160);
  const message = clip(body.message, 2000);
  let custom_answers = null;
  if (body.custom_answers && typeof body.custom_answers === 'object' && !Array.isArray(body.custom_answers)) {
    custom_answers = Object.fromEntries(Object.entries(body.custom_answers).slice(0, 40).map(([k, v]) => [k, typeof v === 'object' ? '' : String(v ?? '').trim().slice(0, 2000)]));
  }
  if (!name) return res.status(400).json({ error: 'Falta el nombre.' });
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'El correo no es válido.' });

  const form = await loadForm(req.params.id);
  if (!form) return res.status(404).json({ error: 'Formulario no encontrado.' });
  const linkedDeal = await dealFromToken(form, typeof body.t === 'string' ? body.t : req.query.t);
  if (!form.active) return res.status(400).json({ error: 'Este formulario ya no está activo.' });
  const settings = normalizeSettings(form.settings);

  // Preguntas del formulario (para validar las obligatorias y nombrarlas en el aviso).
  let defs = [];
  if (form.field_ids?.length) {
    const { data } = await supabase.from('custom_field_definitions').select('id, label, field_type').in('id', form.field_ids);
    defs = data || [];
  }
  const answers = Object.fromEntries(Object.entries(custom_answers || {}).filter(([fid, v]) => form.field_ids?.includes(fid) && String(v ?? '').trim() !== ''));

  const L = settings.labels;
  if (settings.required.email && !email) return res.status(400).json({ error: `Falta: ${L.email || 'Correo'}.` });
  if (settings.required.phone && !phone) return res.status(400).json({ error: `Falta: ${L.phone || 'Teléfono'}.` });
  if (settings.required.company && !company) return res.status(400).json({ error: `Falta: ${L.company || 'Empresa'}.` });
  const missing = settings.required_field_ids.filter((fid) => form.field_ids?.includes(fid) && !answers[fid]);
  if (missing.length) {
    const labels = missing.map((fid) => defs.find((d) => d.id === fid)?.label).filter(Boolean);
    return res.status(400).json({ error: `Falta responder: ${labels.join(' · ') || 'preguntas obligatorias'}.` });
  }

  try {
    let companyId = linkedDeal?.company_id || null;
    if (company && !(linkedDeal?.companies?.name && linkedDeal.companies.name.toLowerCase() === company.toLowerCase())) {
      // (antes: maybeSingle() daba error si ya había 2 con ese nombre y se creaba una tercera)
      const existingId = await require('../utils/findCompany').findCompanyIdByName(company);
      if (existingId) companyId = existingId;
      else {
        const { data: created, error: coErr } = await supabase.from('companies').insert({ name: company }).select('id').single();
        if (coErr) throw coErr;
        companyId = created.id;
      }
    }

    const [firstName, ...rest] = name.split(' ');
    let contactId = null;
    if (linkedDeal?.contact_id && (!email || (linkedDeal.contacts?.email || '').toLowerCase() === email.toLowerCase())) contactId = linkedDeal.contact_id;
    if (!contactId && email) {
      const { data: existing } = await supabase.from('contacts').select('id, phone, company_id').ilike('email', escapeIlikeValue(email)).limit(1).maybeSingle();
      if (existing) {
        contactId = existing.id;
        // Completa lo que le falte al contacto, sin pisar lo que ya tiene.
        const patch = {};
        if (phone && !existing.phone) patch.phone = phone;
        if (companyId && !existing.company_id) patch.company_id = companyId;
        if (Object.keys(patch).length) await supabase.from('contacts').update(patch).eq('id', contactId);
      }
    }
    if (!contactId) {
      const { data: createdContact, error: ctErr } = await supabase
        .from('contacts')
        .insert({
          first_name: firstName || name,
          last_name: rest.join(' ') || null,
          email: email || null,
          phone: phone || null,
          company_id: companyId,
          source: `Formulario: ${form.name}`,
          status: 'nuevo',
        })
        .select('id')
        .single();
      if (ctErr) throw ctErr;
      contactId = createdContact.id;
    }

    // ¿Ya hay un trato de este cliente en el embudo del formulario? Entonces la respuesta va ahí,
    // en vez de crear un duplicado (p. ej. un cliente ya ganado que llena su brief musical).
    let existingDeal = linkedDeal ? { id: linkedDeal.id, title: linkedDeal.title, status: linkedDeal.status, owner_id: linkedDeal.owner_id } : null;
    // Orden: el pipeline del formulario (por contacto y luego por empresa) y después los pipelines
    // adicionales configurados (p. ej. Neomedia para Bit Music), con el mismo criterio.
    if (!existingDeal && settings.match_existing) {
      const cols = 'id, title, status, owner_id, created_at';
      for (const pid of matchPipelineIds(form, settings)) {
        let { data: cands } = await supabase.from('deals').select(cols).eq('pipeline_id', pid).eq('contact_id', contactId);
        existingDeal = pickExistingDeal(cands);
        if (!existingDeal && companyId) {
          ({ data: cands } = await supabase.from('deals').select(cols).eq('pipeline_id', pid).eq('company_id', companyId));
          existingDeal = pickExistingDeal(cands);
        }
        if (existingDeal) break;
      }
    }

    let deal = existingDeal;
    if (!deal) {
      const insert = {
        title: dealTitleFor(settings, { name, company }),
        pipeline_id: form.pipeline_id,
        stage_id: form.stage_id,
        contact_id: contactId,
        company_id: companyId,
        owner_id: form.owner_id || null,
        value: 0,
        currency: 'USD',
        status: 'abierto',
      };
      if (settings.product_line) insert.product_line = settings.product_line;
      let { data: created, error: dealErr } = await supabase.from('deals').insert(insert).select('id, title, status, owner_id').single();
      if (dealErr && insert.product_line && /product_line/.test(dealErr.message || '')) {
        delete insert.product_line;
        ({ data: created, error: dealErr } = await supabase.from('deals').insert(insert).select('id, title, status, owner_id').single());
      }
      if (dealErr) throw dealErr;
      deal = created;
    }

    const rows = Object.entries(answers).map(([fieldId, value]) => ({ field_id: fieldId, entity_id: deal.id, value: String(value), updated_at: new Date().toISOString() }));
    if (rows.length) {
      try {
        // upsert: si el trato ya existía y tenía esas respuestas, se actualizan con las nuevas.
        await supabase.from('custom_field_values').upsert(rows, { onConflict: 'field_id,entity_id' });
      } catch (cfErr) {
        console.error('[lead-forms] no se pudieron guardar las respuestas personalizadas:', cfErr.message);
      }
    }

    const noteLines = [];
    if (existingDeal) noteLines.push(`${name}${company ? ` (${company})` : ''} respondió el formulario «${form.name}».`);
    for (const d of defs) if (answers[d.id]) noteLines.push(`${d.label}: ${answers[d.id]}`);
    if (message) noteLines.push(`Mensaje: ${message}`);
    if (existingDeal || message) {
      try {
        await supabase.from('activities').insert({
          entity_type: 'deal', entity_id: deal.id, type: 'nota',
          title: existingDeal ? `Respuestas del formulario «${form.name}»` : 'Mensaje del formulario',
          summary: (existingDeal ? noteLines.join('\n') : message).slice(0, 8000),
        });
      } catch (noteErr) {
        console.error('[lead-forms] no se pudo guardar la nota:', noteErr.message);
      }
    }

    await supabase.from('lead_forms').update({ submissions_count: (form.submissions_count || 0) + 1 }).eq('id', form.id);

    // Cada envío queda guardado tal cual para las métricas y la tabla de respuestas. Si la tabla aún
    // no existe (falta el script 066), el envío igual funciona.
    try {
      const { error: subErr } = await supabase.from('lead_form_submissions').insert({
        form_id: form.id, deal_id: deal.id, contact_id: contactId, company_id: companyId,
        matched_existing: !!existingDeal,
        answers: { name, email, phone, company, message, custom: answers },
      });
      if (subErr) console.error('[lead-forms] no se pudo guardar el envío:', subErr.message);
    } catch (subErr) {
      console.error('[lead-forms] no se pudo guardar el envío:', subErr.message);
    }

    res.status(201).json({ ok: true });

    // Correo + notificación en la app — después de responder, no debe demorar el envío
    // para el visitante. Si el trato ya tenía responsable, le llega a esa persona; si no, al
    // dueño del formulario; si tampoco hay, a todos los admin.
    notifyNewLead(form, deal, { name, email, phone, company, message }, answers, !!existingDeal).catch((err) => {
      console.error('[lead-forms] no se pudo avisar del nuevo lead:', err.message);
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

async function notifyNewLead(form, deal, submission, customAnswers, attached) {
  const dealId = deal.id;
  const settings = normalizeSettings(form.settings);
  const byEmail = new Map();
  const add = (m) => { if (m?.email) byEmail.set(m.email.toLowerCase(), m); };

  // 1) El responsable: el del trato si la respuesta fue a un trato existente; si no, el del formulario;
  //    si tampoco hay, todos los admin.
  const ownerId = (attached && deal.owner_id) || form.owner_id;
  if (ownerId) {
    const { data: owner } = await supabase.from('team_members').select('id, email, full_name').eq('id', ownerId).maybeSingle();
    add(owner);
  } else {
    const { data: admins } = await supabase.from('team_members').select('id, email, full_name').eq('role', 'admin').eq('active', true);
    (admins || []).forEach(add);
  }
  // 2) Siempre, los correos configurados en el formulario (por defecto mario@bitproximity.com).
  for (const email of settings.notify_emails) {
    if (byEmail.has(email)) continue;
    const { data: tm } = await supabase.from('team_members').select('id, email, full_name').ilike('email', escapeIlikeValue(email)).limit(1).maybeSingle();
    byEmail.set(email, tm || { id: null, email });
  }
  const recipients = [...byEmail.values()];
  if (recipients.length === 0) return { sent: 0 };

  let rows = [];
  if (customAnswers && form.field_ids?.length) {
    const { data: defs } = await supabase.from('custom_field_definitions').select('id, label').in('id', form.field_ids);
    rows = form.field_ids.filter((fid) => customAnswers[fid]).map((fid) => [defs?.find((d) => d.id === fid)?.label || 'Pregunta', customAnswers[fid]]);
  }
  const L = settings.labels;
  const base = [[L.name || 'Nombre', submission.name], [L.email || 'Correo', submission.email], [L.phone || 'Teléfono', submission.phone], [L.company || 'Empresa', submission.company]].filter(([, v]) => v);
  const tr = ([k, v]) => `<tr><td style="padding:8px 14px 8px 0;color:#6B6880;font-size:13px;vertical-align:top;width:42%;border-bottom:1px solid #EEECF3;">${h(k)}</td><td style="padding:8px 0;font-size:14px;color:#14121F;border-bottom:1px solid #EEECF3;white-space:pre-wrap;">${h(v)}</td></tr>`;

  const brand = settings.theme.brand_name || 'Bit CRM';
  const who = submission.company || submission.name;
  const dealUrl = `${PUBLIC_APP_URL}/deals/${dealId}?tab=respuestas`;
  const logo = settings.theme.logo_url ? (settings.theme.logo_url.startsWith('/') ? `${PUBLIC_APP_URL}${settings.theme.logo_url}` : settings.theme.logo_url) : null;
  const html = `
  <div style="background:#F4F3F8;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #E6E3EE;">
      <div style="background:${settings.theme.background || '#080712'};padding:20px 24px;">
        ${logo ? `<img src="${h(logo)}" alt="${h(brand)}" height="32" style="height:32px;display:block;">` : `<span style="color:#fff;font-size:18px;font-weight:bold;">${h(brand)}</span>`}
      </div>
      <div style="height:3px;background:linear-gradient(90deg,${settings.theme.primary || '#8500FF'},${settings.theme.secondary || '#E000FF'});"></div>
      <div style="padding:24px;">
        <p style="margin:0 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#8500FF;">${attached ? 'Respuesta de un cliente' : 'Nueva respuesta'}</p>
        <h1 style="margin:0 0 6px;font-size:20px;color:#14121F;">${h(who)} respondió «${h(form.name)}»</h1>
        <p style="margin:0 0 18px;font-size:14px;color:#6B6880;">${attached ? `Las respuestas quedaron en el trato «${h(deal.title || '')}».` : `Se creó el trato «${h(deal.title || '')}».`}</p>
        <table style="border-collapse:collapse;width:100%;">${base.map(tr).join('')}${rows.map(tr).join('')}</table>
        ${submission.message ? `<p style="margin:16px 0 0;font-size:14px;color:#14121F;"><strong>Mensaje:</strong><br>${h(submission.message)}</p>` : ''}
        <a href="${dealUrl}" style="display:inline-block;margin-top:22px;padding:12px 20px;border-radius:10px;background:#8500FF;color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px;">Ver el trato en Bit CRM</a>
      </div>
    </div>
    <p style="text-align:center;font-size:11px;color:#9A97AA;margin:14px 0 0;">Recibes este aviso porque estás en «Avisar por correo a» de este formulario.</p>
  </div>`;
  const text = [`${who} respondió «${form.name}».`, ...base.map(([k, v]) => `${k}: ${v}`), ...rows.map(([k, v]) => `${k}: ${v}`), submission.message ? `Mensaje: ${submission.message}` : '', `Ver el trato: ${dealUrl}`].filter(Boolean).join('\n');
  const subject = `${attached ? 'Respuesta de cliente' : 'Nuevo lead'} · ${brand}: ${String(who).replace(/[\r\n]+/g, ' ')}`.slice(0, 180);

  let sent = 0;
  for (const r of recipients) {
    const result = await sendEmail({ to: r.email, subject, html, text }).catch((err) => ({ ok: false, error: err.message }));
    if (result && result.ok === false) console.error(`[lead-forms] no se pudo enviar el aviso a ${r.email}: ${result.error}`);
    else sent += 1;
    if (r.id) {
      createNotification({
        recipient_id: r.id, type: 'new_lead',
        title: `${attached ? 'Respondió el formulario' : 'Nuevo lead'}: ${who}`,
        body: `Desde el formulario "${form.name}"`,
        entity_type: 'deal', entity_id: dealId, link: `/deals/${dealId}?tab=respuestas`,
      });
    }
  }
  return { sent };
}

module.exports = router;
