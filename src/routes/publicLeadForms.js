const express = require('express');
const cors = require('cors');
const supabase = require('../config/supabase');
const { sendEmail } = require('../utils/email');
const { createNotification } = require('../utils/notify');
const { escapeHtml: h, escapeIlikeValue } = require('../utils/escape');
const { normalizeSettings, dealTitleFor, pickExistingDeal } = require('../utils/leadFormKit');

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
  const { data, error } = await supabase.from('lead_forms').select('*').eq('id', req.params.id).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Formulario no encontrado.' });

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
  const { long_field_ids, required_field_ids, hints, match_existing, product_line, deal_title, ...publicSettings } = settings;
  res.json({ id: data.id, name: data.name, active: data.active, custom_fields, settings: publicSettings });
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

  const { data: form } = await supabase.from('lead_forms').select('*').eq('id', req.params.id).maybeSingle();
  if (!form) return res.status(404).json({ error: 'Formulario no encontrado.' });
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
    let companyId = null;
    if (company) {
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
    if (email) {
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
    let existingDeal = null;
    if (settings.match_existing) {
      const cols = 'id, title, status, owner_id, created_at';
      let { data: cands } = await supabase.from('deals').select(cols).eq('pipeline_id', form.pipeline_id).eq('contact_id', contactId);
      existingDeal = pickExistingDeal(cands);
      if (!existingDeal && companyId) {
        ({ data: cands } = await supabase.from('deals').select(cols).eq('pipeline_id', form.pipeline_id).eq('company_id', companyId));
        existingDeal = pickExistingDeal(cands);
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
  let recipients = [];
  const ownerId = (attached && deal.owner_id) || form.owner_id;
  if (ownerId) {
    const { data: owner } = await supabase.from('team_members').select('id, email, full_name').eq('id', ownerId).maybeSingle();
    if (owner) recipients = [owner];
  } else {
    const { data: admins } = await supabase.from('team_members').select('id, email, full_name').eq('role', 'admin').eq('active', true);
    recipients = admins || [];
  }
  if (recipients.length === 0) return;

  let customLines = '';
  if (customAnswers && form.field_ids?.length) {
    const { data: defs } = await supabase.from('custom_field_definitions').select('id, label').in('id', form.field_ids);
    customLines = Object.entries(customAnswers)
      .filter(([fieldId, value]) => form.field_ids.includes(fieldId) && value)
      .map(([fieldId, value]) => {
        const label = defs?.find((d) => d.id === fieldId)?.label || fieldId;
        return `<tr><td style="padding:4px 12px 4px 0;color:#8B87A3;">${h(label)}</td><td style="padding:4px 0;">${h(value)}</td></tr>`;
      })
      .join('');
  }

  const dealUrl = `${PUBLIC_APP_URL}/deals/${dealId}`;
  const html = `
    <div style="font-family: sans-serif; color: #1a1a2e; max-width: 480px;">
      <p>${attached ? `Un cliente que ya tenía trato respondió <strong>${h(form.name)}</strong> (las respuestas quedaron en «${h(deal.title || '')}»):` : `Nuevo lead desde <strong>${h(form.name)}</strong>:`}</p>
      <table style="border-collapse:collapse;">
        <tr><td style="padding:4px 12px 4px 0;color:#8B87A3;">Nombre</td><td style="padding:4px 0;">${h(submission.name)}</td></tr>
        ${submission.email ? `<tr><td style="padding:4px 12px 4px 0;color:#8B87A3;">Correo</td><td style="padding:4px 0;">${h(submission.email)}</td></tr>` : ''}
        ${submission.phone ? `<tr><td style="padding:4px 12px 4px 0;color:#8B87A3;">Teléfono</td><td style="padding:4px 0;">${h(submission.phone)}</td></tr>` : ''}
        ${submission.company ? `<tr><td style="padding:4px 12px 4px 0;color:#8B87A3;">Empresa</td><td style="padding:4px 0;">${h(submission.company)}</td></tr>` : ''}
        ${customLines}
      </table>
      ${submission.message ? `<p style="margin-top:12px;"><strong>Mensaje:</strong><br/>${h(submission.message)}</p>` : ''}
      <a href="${dealUrl}" style="display:inline-block;margin-top:16px;color:#8500FF;">Ver el trato en Bit CRM →</a>
    </div>
  `;

  for (const r of recipients) {
    sendEmail({ to: r.email, subject: `${attached ? 'Respuesta de cliente' : 'Nuevo lead'}: ${String(form.name).replace(/[\r\n]+/g, ' ')}`, html }).catch(() => {});
    createNotification({
      recipient_id: r.id, type: 'new_lead',
      title: `${attached ? 'Respondió el formulario' : 'Nuevo lead'}: ${submission.company || submission.name}`,
      body: `Desde el formulario "${form.name}"`,
      entity_type: 'deal', entity_id: dealId, link: `/deals/${dealId}`,
    });
  }
}

module.exports = router;
