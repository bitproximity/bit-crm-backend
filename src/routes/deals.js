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

module.exports = router;
