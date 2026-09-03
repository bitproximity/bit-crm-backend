const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { requirePage } = require('../middleware/pagePermissions');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);
router.use(requirePage('__admin_only__'));

router.get('/', async (req, res) => {
  const { search, page = 1, limit = 50 } = req.query;
  const from = (page - 1) * limit;
  const to = from + Number(limit) - 1;

  let query = supabase
    .from('companies')
    .select('*, team_members(full_name)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (search) query = query.ilike('name', `%${search}%`);

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
  if (!req.body.country || !req.body.country.trim()) {
    return res.status(400).json({ error: 'El país es obligatorio para crear una empresa.' });
  }
  const { data, error } = await supabase.from('companies').insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });

  await logAudit('company', data.id, 'created', req.teamMember.id);
  res.status(201).json(data);
});

router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('companies')
    .update(req.body)
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
