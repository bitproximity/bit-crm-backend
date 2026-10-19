const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { requirePage } = require('../middleware/pagePermissions');
const { logAudit } = require('../utils/audit');
const { cleanName } = require('../utils/mergeRecords');

const router = express.Router();
router.use(requireAuth);
router.use(requirePage('empresas'));

router.get('/', async (req, res) => {
  const { search, country, industry, sort, page = 1, limit = 50 } = req.query;
  const from = (page - 1) * limit;
  const to = from + Number(limit) - 1;

  // contacts(count) / deals(count): cuántos contactos y tratos tiene cada empresa, para mostrarlo en la
  // lista sin pedir el detalle de cada una.
  let query = supabase
    .from('companies')
    .select('*, team_members(full_name), contacts(count), deals(count)', { count: 'exact' });

  // Orden: A–Z por defecto; «recientes» pone primero las últimas creadas.
  query = sort === 'recientes'
    ? query.order('created_at', { ascending: false }).order('id')
    : query.order('name', { ascending: true }).order('id');
  query = query.range(from, to);

  if (search) query = query.ilike('name', `%${search}%`);
  if (country) query = country === '__sin_especificar__' ? query.is('country', null) : query.eq('country', country);
  if (industry) query = industry === '__sin_especificar__' ? query.is('industry', null) : query.eq('industry', industry);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, count });
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const [{ data: company, error }, { data: contacts }, { data: deals }] = await Promise.all([
    supabase.from('companies').select('*').eq('id', id).single(),
    supabase.from('contacts').select('*').eq('company_id', id),
    supabase.from('deals').select('*, pipeline_stages(name)').eq('company_id', id),
  ]);

  if (error) return res.status(404).json({ error: 'Empresa no encontrada' });
  res.json({ ...company, contacts, deals });
});

router.post('/', async (req, res) => {
  const body = { ...req.body, name: cleanName(req.body.name) };
  const { data, error } = await supabase.from('companies').insert(body).select().single();
  if (error) return res.status(400).json({ error: error.message });

  await logAudit('company', data.id, 'created', req.teamMember.id);
  res.status(201).json(data);
});

router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('companies')
    .update('name' in req.body ? { ...req.body, name: cleanName(req.body.name) } : req.body)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  await logAudit('company', id, 'updated', req.teamMember.id, { fields: Object.keys(req.body) });
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('companies').delete().eq('id', id);
  if (error) return res.status(400).json({ error: error.message });

  await logAudit('company', id, 'deleted', req.teamMember.id);
  res.status(204).send();
});

module.exports = router;
