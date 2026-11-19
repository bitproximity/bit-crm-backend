const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { normalizeSettings, computeFormMetrics, TEMPLATES, slugify, validSlug, signDealToken } = require('../utils/leadFormKit');
const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || 'https://crm.bitproximity.com';
const { fetchAll, selectIn } = require('../utils/fetchAll');
const { todayInTz } = require('../utils/businessDate');

const router = express.Router();
router.use(requireAuth);

// GET /api/lead-forms
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('lead_forms')
    .select('*, pipelines(name), pipeline_stages(name), team_members!lead_forms_owner_id_fkey(full_name)')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  // Ajustes ya completados con sus valores por defecto (p. ej. a quién avisar), para que la pantalla
  // muestre lo que de verdad aplica y al guardar no se pierda.
  res.json((data || []).map((f) => ({ ...f, settings: normalizeSettings(f.settings) })));
});

// POST /api/lead-forms  { name, pipeline_id, stage_id, owner_id?, field_ids? }
router.post('/', requireRole('admin'), async (req, res) => {
  const { name, pipeline_id, stage_id, owner_id, field_ids, settings } = req.body;
  if (!name || !pipeline_id || !stage_id) return res.status(400).json({ error: 'Faltan name, pipeline_id o stage_id' });

  const row = { name, pipeline_id, stage_id, owner_id: owner_id || null, field_ids: field_ids || [], created_by: req.teamMember.id };
  if (settings) row.settings = normalizeSettings(settings);
  const { data, error } = await supabase
    .from('lead_forms')
    .insert(row)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });

  await logAudit('lead_form', data.id, 'created', req.teamMember.id);
  res.status(201).json(data);
});

// POST /api/lead-forms/templates/:key — crea un formulario listo desde una plantilla (hoy: bitmusic),
// con sus preguntas como campos de trato. Si ya existe uno con ese nombre, lo devuelve sin duplicar.
router.post('/templates/:key', requireRole('admin'), async (req, res) => {
  const tpl = TEMPLATES[req.params.key];
  if (!tpl) return res.status(404).json({ error: 'Plantilla no encontrada.' });

  const { data: already } = await supabase.from('lead_forms').select('*').eq('name', tpl.name).limit(1).maybeSingle();
  if (already) return res.json({ ...already, already_existed: true });

  let { data: pipe } = await supabase.from('pipelines').select('id, name, pipeline_stages(id, name, position)').ilike('name', tpl.pipeline_name).limit(1).maybeSingle();
  if (!pipe && tpl.create_pipeline_like) {
    // El embudo aún no existe: se crea con las mismas etapas que el modelo (los embudos son estándar).
    const { data: model } = await supabase.from('pipelines').select('id, pipeline_stages(name, position)').ilike('name', tpl.create_pipeline_like).limit(1).maybeSingle();
    const modelStages = [...(model?.pipeline_stages || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    if (!modelStages.length) return res.status(400).json({ error: `No existe el embudo «${tpl.pipeline_name}» ni el modelo «${tpl.create_pipeline_like}» para crearlo.` });
    const { data: all } = await supabase.from('pipelines').select('position');
    const nextPos = Math.max(-1, ...(all || []).map((p) => p.position ?? -1)) + 1;
    const { data: created, error: pErr } = await supabase.from('pipelines').insert({ name: tpl.pipeline_name, position: nextPos }).select('id, name').single();
    if (pErr) return res.status(400).json({ error: `No se pudo crear el embudo «${tpl.pipeline_name}»: ${pErr.message}` });
    const { data: newStages, error: sErr } = await supabase.from('pipeline_stages')
      .insert(modelStages.map((st, i) => ({ pipeline_id: created.id, name: st.name, position: st.position ?? i })))
      .select('id, name, position');
    if (sErr) return res.status(400).json({ error: `Se creó el embudo pero no sus etapas: ${sErr.message}` });
    await logAudit('pipeline', created.id, 'created', req.teamMember.id, { from_template: tpl.key });
    pipe = { ...created, pipeline_stages: newStages || [] };
  }
  if (!pipe) return res.status(400).json({ error: `No existe el embudo «${tpl.pipeline_name}».` });
  const stages = [...(pipe.pipeline_stages || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const stage = stages.find((st) => st.name.toLowerCase() === tpl.stage_name.toLowerCase()) || stages[0];
  if (!stage) return res.status(400).json({ error: `El embudo «${tpl.pipeline_name}» no tiene etapas.` });

  const byKey = {};
  for (const f of tpl.fields) {
    const { data: existing } = await supabase.from('custom_field_definitions').select('id').eq('entity_type', 'deal').eq('key', f.key).limit(1).maybeSingle();
    if (existing) { byKey[f.key] = existing.id; continue; }
    const { data: created, error } = await supabase.from('custom_field_definitions')
      .insert({ entity_type: 'deal', key: f.key, label: f.label, field_type: f.field_type, options: f.options || null })
      .select('id').single();
    if (error) return res.status(400).json({ error: `No se pudo crear la pregunta «${f.label}»: ${error.message}` });
    byKey[f.key] = created.id;
  }

  const settings = normalizeSettings({
    ...tpl.settings,
    long_field_ids: tpl.fields.filter((f) => f.long).map((f) => byKey[f.key]),
    required_field_ids: tpl.fields.filter((f) => f.required).map((f) => byKey[f.key]),
    hints: Object.fromEntries(tpl.fields.filter((f) => f.hint).map((f) => [byKey[f.key], f.hint])),
  });
  const row = {
    name: tpl.name, pipeline_id: pipe.id, stage_id: stage.id, owner_id: null,
    field_ids: tpl.fields.map((f) => byKey[f.key]), settings, active: true, ...(tpl.slug ? { slug: tpl.slug } : {}), created_by: req.teamMember.id,
  };
  let { data, error } = await supabase.from('lead_forms').insert(row).select().single();
  if (error && /slug/.test(error.message || '')) {
    // Sin el script 067 todavía: se crea igual, sin link corto.
    delete row.slug;
    ({ data, error } = await supabase.from('lead_forms').insert(row).select().single());
  }
  if (error) {
    const hint = /settings/.test(error.message || '') ? ' Corre primero el script 066 en Supabase.' : '';
    return res.status(400).json({ error: error.message + hint });
  }
  await logAudit('lead_form', data.id, 'created', req.teamMember.id, { template: tpl.key });
  res.status(201).json(data);
});

// GET /api/lead-forms/:id/responses — cada envío con su trato + métricas del formulario.
router.get('/:id/responses', async (req, res) => {
  const { data: form, error: fErr } = await supabase.from('lead_forms').select('*').eq('id', req.params.id).maybeSingle();
  if (fErr || !form) return res.status(404).json({ error: 'Formulario no encontrado.' });

  const { data: subs, error } = await fetchAll(supabase.from('lead_form_submissions').select('*').eq('form_id', form.id));
  if (error) {
    const missing = /lead_form_submissions|does not exist|schema cache/i.test(error.message || '');
    return res.status(missing ? 409 : 500).json({ error: missing ? 'Falta correr el script 066 en Supabase para guardar las respuestas.' : error.message });
  }

  let fields = [];
  if (form.field_ids?.length) {
    const { data } = await supabase.from('custom_field_definitions').select('id, label, field_type, options').in('id', form.field_ids);
    fields = form.field_ids.map((id) => (data || []).find((d) => d.id === id)).filter(Boolean);
  }
  const { data: deals } = await selectIn(() => supabase.from('deals').select('id, title, status, value, currency, stage_id, pipeline_stages(name)'), 'id', subs.map((s) => s.deal_id));

  const metrics = computeFormMetrics({ submissions: subs, deals, fields, today: todayInTz() });
  const dealById = new Map((deals || []).map((d) => [d.id, d]));
  const rows = [...subs]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map((s) => {
      const d = dealById.get(s.deal_id);
      return {
        id: s.id, created_at: s.created_at, matched_existing: !!s.matched_existing,
        name: s.answers?.name || '', email: s.answers?.email || '', phone: s.answers?.phone || '', company: s.answers?.company || '', message: s.answers?.message || '',
        custom: s.answers?.custom || {},
        deal: d ? { id: d.id, title: d.title, status: d.status, stage: d.pipeline_stages?.name || null } : (s.deal_id ? { id: s.deal_id, title: '(trato eliminado)', status: null } : null),
      };
    });
  res.json({ form: { id: form.id, name: form.name, slug: form.slug || null, pipeline_id: form.pipeline_id, settings: normalizeSettings(form.settings) }, fields, metrics, rows });
});

// GET /api/lead-forms/:id/deal-link?deal_id= — link personalizado para un trato: lo que el cliente
// responda cae en ese trato, con sus datos ya llenos. La firma impide adivinar el de otro trato.
router.get('/:id/deal-link', async (req, res) => {
  const { data: form } = await supabase.from('lead_forms').select('id, slug').eq('id', req.params.id).maybeSingle();
  if (!form) return res.status(404).json({ error: 'Formulario no encontrado.' });
  const { data: deal } = await supabase.from('deals').select('id, title').eq('id', String(req.query.deal_id || '')).maybeSingle();
  if (!deal) return res.status(404).json({ error: 'Trato no encontrado.' });
  const base = `${PUBLIC_APP_URL}/public/${form.slug || `lead-forms/${form.id}`}`;
  res.json({ url: `${base}?t=${encodeURIComponent(signDealToken(form.id, deal.id))}`, deal });
});

// POST /api/lead-forms/submissions/:sid/assign { deal_id } — mueve una respuesta a otro trato:
// copia las respuestas a ese trato, deja nota y la respuesta queda apuntando al nuevo.
router.post('/submissions/:sid/assign', requireRole('admin'), async (req, res) => {
  const { data: sub, error: sErr } = await supabase.from('lead_form_submissions').select('*').eq('id', req.params.sid).maybeSingle();
  if (sErr || !sub) return res.status(404).json({ error: 'Respuesta no encontrada.' });
  const { data: deal } = await supabase.from('deals').select('id, title').eq('id', String(req.body?.deal_id || '')).maybeSingle();
  if (!deal) return res.status(404).json({ error: 'Trato no encontrado.' });
  if (deal.id === sub.deal_id) return res.json({ ok: true, unchanged: true });
  const { data: form } = await supabase.from('lead_forms').select('id, name, field_ids').eq('id', sub.form_id).maybeSingle();

  const custom = sub.answers?.custom || {};
  const rows = Object.entries(custom).filter(([fid, v]) => (form?.field_ids || []).includes(fid) && String(v ?? '').trim() !== '')
    .map(([field_id, value]) => ({ field_id, entity_id: deal.id, value: String(value), updated_at: new Date().toISOString() }));
  if (rows.length) {
    const { error } = await supabase.from('custom_field_values').upsert(rows, { onConflict: 'field_id,entity_id' });
    if (error) return res.status(400).json({ error: error.message });
  }
  let labels = [];
  if (rows.length) {
    const { data: defs } = await supabase.from('custom_field_definitions').select('id, label').in('id', rows.map((r) => r.field_id));
    labels = rows.map((r) => `${defs?.find((d) => d.id === r.field_id)?.label || 'Pregunta'}: ${r.value}`);
  }
  const a = sub.answers || {};
  await supabase.from('activities').insert({
    entity_type: 'deal', entity_id: deal.id, type: 'nota',
    title: `Respuestas del formulario «${form?.name || ''}» (asignadas a mano)`,
    summary: [`${a.name || ''}${a.company ? ` (${a.company})` : ''} · ${a.email || ''}`, ...labels, a.message ? `Mensaje: ${a.message}` : ''].filter(Boolean).join('\n').slice(0, 8000),
  });
  const previous = sub.deal_id;
  const { error: uErr } = await supabase.from('lead_form_submissions').update({ deal_id: deal.id, matched_existing: true }).eq('id', sub.id);
  if (uErr) return res.status(400).json({ error: uErr.message });
  await logAudit('lead_form', sub.form_id, 'updated', req.teamMember.id, { submission: sub.id, from_deal: previous, to_deal: deal.id });
  // Si el trato anterior lo había creado esta misma respuesta, se avisa para poder borrarlo.
  res.json({ ok: true, deal, previous_deal_id: previous, previous_was_auto_created: !sub.matched_existing && !!previous });
});

// PATCH /api/lead-forms/:id  { name?, active?, owner_id?, pipeline_id?, stage_id? }
const EDITABLE = ['name', 'active', 'owner_id', 'pipeline_id', 'stage_id', 'field_ids', 'settings', 'slug'];
router.patch('/:id', requireRole('admin'), async (req, res) => {
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => EDITABLE.includes(k)));
  if (patch.settings !== undefined) patch.settings = normalizeSettings(patch.settings);
  if (patch.slug !== undefined) {
    if (patch.slug === null || patch.slug === '') patch.slug = null;
    else {
      const slug = slugify(patch.slug);
      if (!validSlug(slug)) return res.status(400).json({ error: 'Ese link no sirve: usa letras, números y guiones (ej. bitmusic).' });
      const { data: taken } = await supabase.from('lead_forms').select('id').eq('slug', slug).neq('id', req.params.id).limit(1).maybeSingle();
      if (taken) return res.status(409).json({ error: `El link «${slug}» ya lo usa otro formulario.` });
      patch.slug = slug;
    }
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nada que actualizar.' });
  const { data, error } = await supabase.from('lead_forms').update(patch).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  await logAudit('lead_form', req.params.id, 'updated', req.teamMember.id, { fields: Object.keys(patch) });
  res.json(data);
});

// DELETE /api/lead-forms/:id
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { error } = await supabase.from('lead_forms').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  await logAudit('lead_form', req.params.id, 'deleted', req.teamMember.id);
  res.status(204).send();
});

module.exports = router;
