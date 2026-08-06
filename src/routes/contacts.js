const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

// GET /api/contacts?status=&owner_id=&search=&page=&limit=
router.get('/', async (req, res) => {
  const { status, owner_id, search, page = 1, limit = 50 } = req.query;
  const from = (page - 1) * limit;
  const to = from + Number(limit) - 1;

  let query = supabase
    .from('contacts')
    .select('*, companies(name), team_members!contacts_owner_id_fkey(full_name)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (status) query = query.eq('status', status);
  if (owner_id) query = query.eq('owner_id', owner_id);
  if (search) {
    query = query.or(
      `first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`
    );
  }

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, count });
});

// GET /api/contacts/:id (incluye actividades y deals asociados)
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  const [{ data: contact, error }, { data: activities }, { data: deals }, { data: tasks }] =
    await Promise.all([
      supabase.from('contacts').select('*, companies(*)').eq('id', id).single(),
      supabase
        .from('activities')
        .select('*, team_members(full_name)')
        .eq('entity_type', 'contact')
        .eq('entity_id', id)
        .order('occurred_at', { ascending: false }),
      supabase.from('deals').select('*, pipeline_stages(name)').eq('contact_id', id),
      supabase.from('tasks').select('*').eq('contact_id', id).order('due_date'),
    ]);

  if (error) return res.status(404).json({ error: 'Contacto no encontrado' });
  res.json({ ...contact, activities, deals, tasks });
});

// POST /api/contacts
router.post('/', async (req, res) => {
  const payload = req.body;
  const { data, error } = await supabase.from('contacts').insert(payload).select().single();
  if (error) return res.status(400).json({ error: error.message });

  await logAudit('contact', data.id, 'created', req.teamMember.id);
  res.status(201).json(data);
});

// PATCH /api/contacts/:id
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('contacts')
    .update(req.body)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  await logAudit('contact', id, 'updated', req.teamMember.id, { fields: Object.keys(req.body) });
  res.json(data);
});

// DELETE /api/contacts/:id
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('contacts').delete().eq('id', id);
  if (error) return res.status(400).json({ error: error.message });

  await logAudit('contact', id, 'deleted', req.teamMember.id);
  res.status(204).send();
});

// POST /api/contacts/import  { contacts: [{ first_name, last_name, email, phone, company_name, source }] }
// Importación masiva desde CSV. Si company_name viene y no existe la empresa, la crea.
router.post('/import', async (req, res) => {
  const { contacts } = req.body;
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: 'Falta el array de contactos' });
  }

  const results = { created: 0, errors: [] };

  for (const [i, c] of contacts.entries()) {
    try {
      if (!c.first_name) {
        results.errors.push({ row: i + 1, error: 'Falta first_name' });
        continue;
      }

      let company_id = null;
      if (c.company_name) {
        const { data: existing } = await supabase
          .from('companies')
          .select('id')
          .ilike('name', c.company_name)
          .maybeSingle();

        if (existing) {
          company_id = existing.id;
        } else {
          const { data: newCompany } = await supabase
            .from('companies')
            .insert({ name: c.company_name })
            .select()
            .single();
          company_id = newCompany?.id || null;
        }
      }

      const { data: contact, error } = await supabase
        .from('contacts')
        .insert({
          first_name: c.first_name,
          last_name: c.last_name || null,
          email: c.email || null,
          phone: c.phone || null,
          company_id,
          source: c.source || 'importado',
          owner_id: req.teamMember.id,
        })
        .select()
        .single();

      if (error) {
        results.errors.push({ row: i + 1, error: error.message });
      } else {
        results.created++;
        await logAudit('contact', contact.id, 'created', req.teamMember.id, { via: 'import' });
      }
    } catch (err) {
      results.errors.push({ row: i + 1, error: err.message });
    }
  }

  res.json(results);
});

module.exports = router;
