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
// Inserta un array grande en lotes (evita timeouts/payloads gigantes en Supabase)
async function batchInsert(table, rows, chunkSize = 500) {
  const inserted = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { data, error } = await supabase.from(table).insert(chunk).select();
    if (error) throw new Error(error.message);
    inserted.push(...(data || []));
  }
  return inserted;
}

router.post('/import', async (req, res) => {
  const { contacts } = req.body;
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: 'Falta el array de contactos' });
  }

  const results = { created: 0, errors: [] };

  // Trae todas las empresas existentes de una vez (evita una consulta por fila)
  const { data: existingCompanies } = await supabase.from('companies').select('id, name');
  const companyMap = new Map((existingCompanies || []).map((c) => [c.name.toLowerCase().trim(), c.id]));

  const newCompanyNames = new Set();
  contacts.forEach((c) => {
    if (c.company_name && !companyMap.has(c.company_name.toLowerCase().trim())) {
      newCompanyNames.add(c.company_name.trim());
    }
  });

  if (newCompanyNames.size > 0) {
    const created = await batchInsert('companies', [...newCompanyNames].map((name) => ({ name })));
    created.forEach((c) => companyMap.set(c.name.toLowerCase().trim(), c.id));
  }

  const contactsToInsert = [];
  contacts.forEach((c, i) => {
    if (!c.first_name) {
      results.errors.push({ row: i + 1, error: 'Falta first_name' });
      return;
    }
    contactsToInsert.push({
      first_name: c.first_name,
      last_name: c.last_name || null,
      email: c.email || null,
      phone: c.phone || null,
      company_id: c.company_name ? companyMap.get(c.company_name.toLowerCase().trim()) || null : null,
      source: c.source || 'importado',
      owner_id: req.teamMember.id,
    });
  });

  if (contactsToInsert.length > 0) {
    try {
      const createdContacts = await batchInsert('contacts', contactsToInsert);
      results.created = createdContacts.length;
      await batchInsert(
        'audit_log',
        createdContacts.map((contact) => ({
          entity_type: 'contact',
          entity_id: contact.id,
          action: 'created',
          actor_id: req.teamMember.id,
          changes: { via: 'import' },
        }))
      );
    } catch (err) {
      results.errors.push({ row: 0, error: `Error insertando contactos: ${err.message}` });
    }
  }

  res.json(results);
});

module.exports = router;
