const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { normalizeSettings, computeFormMetrics, TEMPLATES } = require('../utils/leadFormKit');
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
  res.json(data);
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

  const { data: pipe } = await supabase.from('pipelines').select('id, name, pipeline_stages(id, name, position)').ilike('name', tpl.pipeline_name).limit(1).maybeSingle();
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
  const { data, error } = await supabase.from('lead_forms').insert({
    name: tpl.name, pipeline_id: pipe.id, stage_id: stage.id, owner_id: null,
    field_ids: tpl.fields.map((f) => byKey[f.key]), settings, active: true, created_by: req.teamMember.id,
  }).select().single();
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
  res.json({ form: { id: form.id, name: form.name, settings: normalizeSettings(form.settings) }, fields, metrics, rows });
});

// PATCH /api/lead-forms/:id  { name?, active?, owner_id?, pipeline_id?, stage_id? }
const EDITABLE = ['name', 'active', 'owner_id', 'pipeline_id', 'stage_id', 'field_ids', 'settings'];
router.patch('/:id', requireRole('admin'), async (req, res) => {
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => EDITABLE.includes(k)));
  if (patch.settings !== undefined) patch.settings = normalizeSettings(patch.settings);
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
