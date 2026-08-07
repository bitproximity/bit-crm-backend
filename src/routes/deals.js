const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

// GET /api/deals?pipeline_id=&owner_id=&status=
router.get('/', async (req, res) => {
  const { pipeline_id, owner_id, status } = req.query;

  let query = supabase
    .from('deals')
    .select('*, contacts(first_name,last_name), companies(name), pipeline_stages(name,position)')
    .order('updated_at', { ascending: false });

  if (pipeline_id) query = query.eq('pipeline_id', pipeline_id);
  if (owner_id) query = query.eq('owner_id', owner_id);
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const [{ data: deal, error }, { data: history }, { data: tasks }] = await Promise.all([
    supabase
      .from('deals')
      .select('*, contacts(*), companies(*), pipeline_stages(*)')
      .eq('id', id)
      .single(),
    supabase
      .from('deal_stage_history')
      .select('*, team_members(full_name)')
      .eq('deal_id', id)
      .order('changed_at', { ascending: false }),
    supabase.from('tasks').select('*').eq('deal_id', id),
  ]);

  if (error) return res.status(404).json({ error: 'Deal no encontrado' });
  res.json({ ...deal, history, tasks });
});

router.post('/', async (req, res) => {
  const { data, error } = await supabase.from('deals').insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });

  await logAudit('deal', data.id, 'created', req.teamMember.id);
  res.status(201).json(data);
});

// PATCH /api/deals/:id — actualización general (título, valor, dueño, etc.)
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('deals')
    .update(req.body)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  await logAudit('deal', id, 'updated', req.teamMember.id, { fields: Object.keys(req.body) });
  res.json(data);
});

// PATCH /api/deals/:id/stage — mover de etapa en el kanban (registra historial)
router.patch('/:id/stage', async (req, res) => {
  const { id } = req.params;
  const { stage_id } = req.body;

  const { data: current } = await supabase.from('deals').select('stage_id').eq('id', id).single();

  const { data: updated, error } = await supabase
    .from('deals')
    .update({ stage_id })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  await supabase.from('deal_stage_history').insert({
    deal_id: id,
    from_stage_id: current?.stage_id || null,
    to_stage_id: stage_id,
    changed_by: req.teamMember.id,
  });

  await logAudit('deal', id, 'stage_changed', req.teamMember.id, {
    stage: { from: current?.stage_id, to: stage_id },
  });

  res.json(updated);
});

// POST /api/deals/:id/win — marca ganado y opcionalmente instancia un proyecto de onboarding
router.post('/:id/win', async (req, res) => {
  const { id } = req.params;
  const { template_id } = req.body; // opcional: task_templates.id

  const { data: deal, error } = await supabase
    .from('deals')
    .update({ status: 'ganado', closed_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  await logAudit('deal', id, 'status_changed', req.teamMember.id, { status: { to: 'ganado' } });

  let project = null;
  if (template_id) {
    project = await instantiateProjectFromTemplate({
      templateId: template_id,
      dealId: id,
      companyId: deal.company_id,
      ownerId: req.teamMember.id,
    });
  }

  res.json({ deal, project });
});

// POST /api/deals/:id/lose
router.post('/:id/lose', async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  const { data, error } = await supabase
    .from('deals')
    .update({ status: 'perdido', closed_at: new Date().toISOString(), lost_reason: reason })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  await logAudit('deal', id, 'status_changed', req.teamMember.id, { status: { to: 'perdido' } });
  res.json(data);
});

/**
 * Crea un proyecto + tareas a partir de una plantilla de onboarding.
 * Se usa al ganar un deal, conectando ventas -> operaciones automáticamente.
 */
async function instantiateProjectFromTemplate({ templateId, dealId, companyId, ownerId }) {
  const { data: template } = await supabase
    .from('task_templates')
    .select('*, task_template_items(*)')
    .eq('id', templateId)
    .single();

  if (!template) return null;

  const { data: project } = await supabase
    .from('projects')
    .insert({
      name: `Onboarding — ${template.name}`,
      type: 'onboarding_cliente',
      company_id: companyId,
      deal_id: dealId,
      owner_id: ownerId,
      start_date: new Date().toISOString().slice(0, 10),
    })
    .select()
    .single();

  const items = (template.task_template_items || []).sort((a, b) => a.position - b.position);
  const tasksToInsert = items.map((item) => {
    const due = new Date();
    due.setDate(due.getDate() + (item.days_offset || 0));
    return {
      project_id: project.id,
      title: item.title,
      description: item.description,
      due_date: due.toISOString(),
      position: item.position,
    };
  });

  if (tasksToInsert.length) {
    await supabase.from('tasks').insert(tasksToInsert);
  }

  return project;
}

// POST /api/deals/import  { pipeline_id, deals: [{ title, value, currency, stage_name, contact_name, contact_email, company_name, probability }] }
// Mapea stage_name al stage_id real del pipeline por nombre (case-insensitive).
// Si contact_name/company_name no existen, los crea.
router.post('/import', async (req, res) => {
  const { pipeline_id, deals } = req.body;
  if (!pipeline_id || !Array.isArray(deals) || deals.length === 0) {
    return res.status(400).json({ error: 'Falta pipeline_id o el array de deals' });
  }

  const { data: stages } = await supabase.from('pipeline_stages').select('*').eq('pipeline_id', pipeline_id);
  const stageByName = {};
  (stages || []).forEach((s) => { stageByName[s.name.toLowerCase().trim()] = s.id; });
  const defaultStageId = stages?.sort((a, b) => a.position - b.position)[0]?.id;

  const results = { created: 0, errors: [] };

  for (const [i, d] of deals.entries()) {
    try {
      if (!d.title) {
        results.errors.push({ row: i + 1, error: 'Falta el título del deal' });
        continue;
      }

      let company_id = null;
      if (d.company_name) {
        const { data: existing } = await supabase.from('companies').select('id').ilike('name', d.company_name).maybeSingle();
        if (existing) company_id = existing.id;
        else {
          const { data: nc } = await supabase.from('companies').insert({ name: d.company_name }).select().single();
          company_id = nc?.id || null;
        }
      }

      let contact_id = null;
      if (d.contact_name) {
        const [first_name, ...rest] = d.contact_name.split(' ');
        const { data: existing } = await supabase
          .from('contacts')
          .select('id')
          .ilike('first_name', first_name)
          .eq('company_id', company_id)
          .maybeSingle();
        if (existing) contact_id = existing.id;
        else {
          const { data: nc } = await supabase
            .from('contacts')
            .insert({
              first_name,
              last_name: rest.join(' ') || null,
              email: d.contact_email || null,
              company_id,
              owner_id: req.teamMember.id,
              source: 'importado',
            })
            .select()
            .single();
          contact_id = nc?.id || null;
        }
      }

      const stage_id = (d.stage_name && stageByName[d.stage_name.toLowerCase().trim()]) || defaultStageId;
      if (!stage_id) {
        results.errors.push({ row: i + 1, error: 'El pipeline no tiene etapas configuradas' });
        continue;
      }

      const { data: deal, error } = await supabase
        .from('deals')
        .insert({
          title: d.title,
          value: Number(d.value) || 0,
          currency: d.currency || 'USD',
          probability: Number(d.probability) || 50,
          pipeline_id,
          stage_id,
          contact_id,
          company_id,
          owner_id: req.teamMember.id,
        })
        .select()
        .single();

      if (error) {
        results.errors.push({ row: i + 1, error: error.message });
      } else {
        results.created++;
        await logAudit('deal', deal.id, 'created', req.teamMember.id, { via: 'import' });
      }
    } catch (err) {
      results.errors.push({ row: i + 1, error: err.message });
    }
  }

  res.json(results);
});

// ── LÍNEAS DE PRODUCTO DEL DEAL ──────────────────────────────

// GET /api/deals/:id/line-items
router.get('/:id/line-items', async (req, res) => {
  const { data, error } = await supabase
    .from('deal_line_items')
    .select('*, products(name, sku)')
    .eq('deal_id', req.params.id)
    .order('created_at');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/deals/:id/line-items  { product_id?, description?, quantity, unit_price, currency }
router.post('/:id/line-items', async (req, res) => {
  const { data, error } = await supabase
    .from('deal_line_items')
    .insert({ ...req.body, deal_id: req.params.id })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  await logAudit('deal', req.params.id, 'updated', req.teamMember.id, { line_item: 'added' });
  res.status(201).json(data);
});

router.delete('/:id/line-items/:itemId', async (req, res) => {
  const { error } = await supabase.from('deal_line_items').delete().eq('id', req.params.itemId);
  if (error) return res.status(400).json({ error: error.message });
  await logAudit('deal', req.params.id, 'updated', req.teamMember.id, { line_item: 'removed' });
  res.status(204).send();
});

module.exports = router;
