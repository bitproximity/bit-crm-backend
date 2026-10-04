const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const ASSOC_FIELDS = ['company_id', 'project_id', 'deal_id'];

// Completa company_id a partir del proyecto o trato (un documento de un proyecto
// pertenece también a la empresa de ese proyecto), y hereda la asociación de la página
// padre cuando es una subpágina — así nada queda "suelto" sin querer.
async function resolveAssociation(input) {
  const out = {};
  ASSOC_FIELDS.forEach((f) => { if (f in input) out[f] = input[f] || null; });

  if (input.parent_id) {
    const { data: parent } = await supabase.from('documents').select('company_id, project_id, deal_id').eq('id', input.parent_id).maybeSingle();
    if (parent) ASSOC_FIELDS.forEach((f) => { if (!(f in input)) out[f] = parent[f]; });
  }

  if (out.project_id && !out.company_id) {
    const { data: p } = await supabase.from('projects').select('company_id').eq('id', out.project_id).maybeSingle();
    out.company_id = p?.company_id || null;
  }
  if (out.deal_id && !out.company_id) {
    const { data: d } = await supabase.from('deals').select('company_id').eq('id', out.deal_id).maybeSingle();
    out.company_id = d?.company_id || null;
  }
  return out;
}

// Al mover una página a otra empresa/proyecto, sus subpáginas se mueven con ella.
async function cascadeAssociation(rootId, assoc) {
  let frontier = [rootId];
  while (frontier.length) {
    const { data: children } = await supabase.from('documents').select('id').in('parent_id', frontier);
    const ids = (children || []).map((c) => c.id);
    if (!ids.length) break;
    await supabase.from('documents').update(assoc).in('id', ids);
    frontier = ids;
  }
}

// GET /api/documents/tree?company_id=&project_id=&deal_id=
// Árbol (sin contenido) con los nombres de empresa/proyecto/trato para agrupar el sidebar.
// company_id trae todo lo de la empresa, incluidos documentos de sus proyectos y tratos.
router.get('/tree', async (req, res) => {
  const { deal_id, project_id, company_id } = req.query;
  const build = (withCompany) => {
    let query = supabase
      .from('documents')
      .select(withCompany
        ? 'id, title, parent_id, space_id, deal_id, project_id, company_id, position, updated_at, companies(name), projects(name), deals(title)'
        : 'id, title, parent_id, space_id, deal_id, project_id, position, updated_at, projects(name), deals(title)')
      .order('position')
      .order('created_at');
    if (deal_id) query = query.eq('deal_id', deal_id);
    if (project_id) query = query.eq('project_id', project_id);
    if (company_id && withCompany) query = query.eq('company_id', company_id);
    return query;
  };

  let { data, error } = await build(true);
  // Mientras la migración 050 (documents.company_id) no haya corrido, sigue funcionando sin empresa
  if (error && /company_id|companies/i.test(error.message)) ({ data, error } = await build(false));
  if (error) return res.status(500).json({ error: error.message });

  res.json((data || []).map(({ companies, projects, deals, ...d }) => ({
    ...d,
    company_name: companies?.name || null,
    project_name: projects?.name || null,
    deal_title: deals?.title || null,
  })));
});

// GET /api/documents/:id — documento con su contenido completo
router.get('/:id', async (req, res) => {
  let { data, error } = await supabase
    .from('documents')
    .select('*, team_members(full_name), companies(id, name), projects(id, name), deals(id, title)')
    .eq('id', req.params.id)
    .single();
  if (error && /compan/i.test(error.message)) {
    ({ data, error } = await supabase.from('documents').select('*, team_members(full_name), projects(id, name), deals(id, title)').eq('id', req.params.id).single());
  }

  if (error) return res.status(404).json({ error: 'Documento no encontrado' });
  res.json(data);
});

// POST /api/documents  { title?, content?, parent_id?, company_id?, project_id?, deal_id? }
router.post('/', async (req, res) => {
  const assoc = await resolveAssociation(req.body);
  const payload = { ...req.body, ...assoc, created_by: req.teamMember.id };
  const { data, error } = await supabase.from('documents').insert(payload).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/documents/:id  { title?, content?, parent_id?, position?, company_id?, project_id?, deal_id? }
router.patch('/:id', async (req, res) => {
  const touchesAssoc = ASSOC_FIELDS.some((f) => f in req.body);
  let update = { ...req.body, updated_at: new Date().toISOString() };

  if (touchesAssoc) {
    // Cambiar de empresa limpia proyecto/trato que no le pertenezcan, y viceversa
    // Se reemplaza la asociación completa: lo que no venga queda en null.
    const assoc = await resolveAssociation({
      company_id: req.body.company_id ?? null,
      project_id: req.body.project_id ?? null,
      deal_id: req.body.deal_id ?? null,
    });
    update = { ...update, ...assoc };
    // Moverlo de empresa lo saca de su página padre (si no, quedaría colgando de un árbol de otra empresa)
    if (!('parent_id' in req.body)) update.parent_id = null;
  }

  const { data, error } = await supabase
    .from('documents')
    .update(update)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  if (touchesAssoc) {
    await cascadeAssociation(req.params.id, { company_id: data.company_id, project_id: data.project_id, deal_id: data.deal_id });
  }
  res.json(data);
});

// DELETE /api/documents/:id — borra el documento y sus hijos (cascade en la FK)
router.delete('/:id', async (req, res) => {
  const { error } = await supabase.from('documents').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
});

module.exports = router;
