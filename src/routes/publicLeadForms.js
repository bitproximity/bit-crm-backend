const express = require('express');
const cors = require('cors');
const supabase = require('../config/supabase');

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
  const { data, error } = await supabase.from('lead_forms').select('id, name, active, field_ids').eq('id', req.params.id).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Formulario no encontrado.' });

  let custom_fields = [];
  if (data.field_ids?.length) {
    const { data: defs } = await supabase.from('custom_field_definitions').select('id, key, label, field_type, options').in('id', data.field_ids);
    // Respeta el orden en que Mario los eligió al armar el formulario, no el orden de la tabla.
    custom_fields = (data.field_ids || []).map((id) => defs?.find((d) => d.id === id)).filter(Boolean);
  }
  res.json({ id: data.id, name: data.name, active: data.active, custom_fields });
});

// POST /api/public/lead-forms/:id/submit  { name, email?, phone?, company?, message?, custom_answers?: { field_id: value } }
router.post('/:id/submit', async (req, res) => {
  const { name, email, phone, company, message, custom_answers } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Falta el nombre.' });

  const { data: form } = await supabase.from('lead_forms').select('*').eq('id', req.params.id).maybeSingle();
  if (!form) return res.status(404).json({ error: 'Formulario no encontrado.' });
  if (!form.active) return res.status(400).json({ error: 'Este formulario ya no está activo.' });

  try {
    let companyId = null;
    if (company && company.trim()) {
      const { data: existing } = await supabase.from('companies').select('id').ilike('name', company.trim()).maybeSingle();
      if (existing) companyId = existing.id;
      else {
        const { data: created, error: coErr } = await supabase.from('companies').insert({ name: company.trim() }).select('id').single();
        if (coErr) throw coErr;
        companyId = created.id;
      }
    }

    const [firstName, ...rest] = String(name).trim().split(' ');
    let contactId = null;
    if (email && email.trim()) {
      const { data: existing } = await supabase.from('contacts').select('id').ilike('email', email.trim()).maybeSingle();
      if (existing) contactId = existing.id;
    }
    if (!contactId) {
      const { data: createdContact, error: ctErr } = await supabase
        .from('contacts')
        .insert({
          first_name: firstName || name.trim(),
          last_name: rest.join(' ') || null,
          email: email?.trim() || null,
          phone: phone?.trim() || null,
          company_id: companyId,
          source: `Formulario: ${form.name}`,
          status: 'nuevo',
        })
        .select('id')
        .single();
      if (ctErr) throw ctErr;
      contactId = createdContact.id;
    }

    const { data: deal, error: dealErr } = await supabase
      .from('deals')
      .insert({
        title: `Lead: ${company?.trim() || name.trim()}`,
        pipeline_id: form.pipeline_id,
        stage_id: form.stage_id,
        contact_id: contactId,
        company_id: companyId,
        owner_id: form.owner_id || null,
        value: 0,
        currency: 'USD',
        status: 'abierto',
      })
      .select('id')
      .single();
    if (dealErr) throw dealErr;

    if (custom_answers && typeof custom_answers === 'object') {
      const rows = Object.entries(custom_answers)
        .filter(([fieldId, value]) => form.field_ids?.includes(fieldId) && value !== undefined && value !== null && String(value).trim() !== '')
        .map(([fieldId, value]) => ({ field_id: fieldId, entity_id: deal.id, value: String(value) }));
      if (rows.length) {
        try {
          await supabase.from('custom_field_values').insert(rows);
        } catch (cfErr) {
          console.error('[lead-forms] no se pudieron guardar las respuestas personalizadas:', cfErr.message);
        }
      }
    }

    if (message && message.trim()) {
      // No es una promesa nativa (es el query builder de Supabase) — .catch() encadenado
      // directo falla con "is not a function". Si esto falla (ej. author_id no admite
      // nulo), no debe tumbar el envío del formulario — el trato ya se creó, que es lo
      // que importa — así que va en su propio try/catch.
      try {
        await supabase.from('activities').insert({
          entity_type: 'deal', entity_id: deal.id, type: 'nota',
          title: 'Mensaje del formulario', summary: message.trim(),
        });
      } catch (noteErr) {
        console.error('[lead-forms] no se pudo guardar la nota del mensaje:', noteErr.message);
      }
    }

    await supabase.from('lead_forms').update({ submissions_count: (form.submissions_count || 0) + 1 }).eq('id', form.id);

    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
