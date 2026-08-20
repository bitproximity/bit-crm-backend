const express = require('express');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { requirePage } = require('../middleware/pagePermissions');
const { computeB2bDashboard } = require('../utils/b2bDashboard');

const router = express.Router();
router.use(requireAuth);
router.use(requirePage('b2b'));

// Personas que hacen prospección/reuniones para Bit Prospect (no todo el equipo del CRM
// aplica — ej. soporte técnico no debe aparecer en "Rendimiento por persona").
// Si el equipo de prospección cambia, actualiza esta lista.
const BIT_PROSPECT_TEAM_EXCLUDE = ['Diego Molina'];

async function getBitProspectTeam() {
  const { data } = await supabase.from('team_members').select('full_name').eq('active', true);
  return (data || []).filter((m) => !BIT_PROSPECT_TEAM_EXCLUDE.includes(m.full_name));
}

// GET /api/b2b/clients — empresas marcadas como clientes del servicio
router.get('/clients', async (req, res) => {
  const { data, error } = await supabase
    .from('companies')
    .select('id, name, b2b_share_token, b2b_order')
    .eq('is_b2b_client', true)
    .order('b2b_order', { ascending: true, nullsFirst: false })
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /api/b2b/clients/reorder  { ordered_ids: [uuid, ...] } — define el orden del selector de marcas
router.patch('/clients/reorder', async (req, res) => {
  const { ordered_ids } = req.body;
  if (!Array.isArray(ordered_ids) || ordered_ids.length === 0) {
    return res.status(400).json({ error: 'ordered_ids debe ser un array de IDs.' });
  }
  for (let i = 0; i < ordered_ids.length; i++) {
    const { error } = await supabase.from('companies').update({ b2b_order: i }).eq('id', ordered_ids[i]);
    if (error) return res.status(400).json({ error: `Falló en el ID ${ordered_ids[i]}: ${error.message}` });
  }
  res.json({ reordered: true, count: ordered_ids.length });
});

// POST /api/b2b/clients  { company_id }  — marca una empresa existente como cliente del servicio
router.post('/clients', async (req, res) => {
  const { company_id } = req.body;
  if (!company_id) return res.status(400).json({ error: 'Falta company_id' });
  const { data, error } = await supabase.from('companies').update({ is_b2b_client: true }).eq('id', company_id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// POST /api/b2b/clients/:id/share-link — genera (o reutiliza) el link público de solo lectura del cliente
router.post('/clients/:id/share-link', async (req, res) => {
  const { data: company } = await supabase.from('companies').select('b2b_share_token').eq('id', req.params.id).single();
  let token = company?.b2b_share_token;
  if (!token) {
    const { data, error } = await supabase.from('companies').update({ b2b_share_token: crypto.randomUUID() }).eq('id', req.params.id).select('b2b_share_token').single();
    if (error) return res.status(400).json({ error: error.message });
    token = data.b2b_share_token;
  }
  res.json({ token });
});

// GET /api/b2b/records?client_company_id=&status=
router.get('/records', async (req, res) => {
  const { client_company_id, status } = req.query;
  if (!client_company_id) return res.status(400).json({ error: 'Falta client_company_id' });

  let query = supabase.from('b2b_records').select('*').eq('client_company_id', client_company_id).order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/b2b/records — crear un registro manual (un contacto o una reunión, cargado a mano)
router.post('/records', async (req, res) => {
  const { data, error } = await supabase.from('b2b_records').insert({ ...req.body, created_by: req.teamMember.id }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/b2b/records/:id — editar cualquier campo de un registro (manual, desde la tarjeta)
router.patch('/records/:id', async (req, res) => {
  const { data, error } = await supabase.from('b2b_records').update({ ...req.body, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

router.delete('/records/:id', async (req, res) => {
  const { error } = await supabase.from('b2b_records').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
});

// DELETE /api/b2b/clients/:id/records — borra TODOS los registros de un cliente puntual
// (para recargar desde cero sin arriesgar datos de otras marcas)
router.delete('/clients/:id/records', async (req, res) => {
  const { error, count } = await supabase.from('b2b_records').delete({ count: 'exact' }).eq('client_company_id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ deleted: count || 0 });
});

// POST /api/b2b/import  { client_company_id, mode: 'contactados' | 'reuniones', records: [...], mergeByCompany? }
// Carga masiva desde CSV. En modo 'reuniones', si mergeByCompany=true (default) y el target_company
// ya existe como 'contactado' para ese cliente, lo actualiza en vez de duplicar la fila — pensado para
// una base donde cada empresa aparece una sola vez. Si mergeByCompany=false, cada fila se inserta
// siempre como un registro nuevo — pensado para un historial donde la misma empresa puede tener
// varias reuniones reales en fechas distintas (no se deben fusionar).
router.post('/import', async (req, res) => {
  const { client_company_id, mode, records, mergeByCompany = true } = req.body;
  if (!client_company_id || !Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'Falta client_company_id o records' });
  }

  let inserted = 0;
  let updated = 0;
  const BATCH = 500;

  if (mode === 'reuniones') {
    const today = new Date().toISOString().slice(0, 10);
    const statusFor = (r) => (r.meeting_date && r.meeting_date < today ? 'reunion_realizada' : 'reunion_agendada');

    const existingMap = new Map();
    if (mergeByCompany) {
      const { data: existing } = await supabase
        .from('b2b_records')
        .select('id, target_company')
        .eq('client_company_id', client_company_id);
      (existing || []).forEach((r) => existingMap.set(r.target_company.toLowerCase().trim(), r.id));
    }

    const toInsert = [];
    for (const r of records) {
      const key = (r.target_company || '').toLowerCase().trim();
      if (mergeByCompany && key && existingMap.has(key)) {
        await supabase.from('b2b_records').update({
          status: statusFor(r),
          meeting_date: r.meeting_date || null,
          target_contact: r.target_contact || undefined,
          target_position: r.target_position || undefined,
          target_email: r.target_email || undefined,
          target_phone: r.target_phone || undefined,
          executive: r.executive || undefined,
          notes: r.notes || undefined,
          updated_at: new Date().toISOString(),
        }).eq('id', existingMap.get(key));
        updated++;
      } else {
        toInsert.push({
          client_company_id, target_company: r.target_company, target_contact: r.target_contact || null,
          industry: r.industry || null, country: r.country || null,
          target_position: r.target_position || null, target_email: r.target_email || null,
          target_phone: r.target_phone || null, executive: r.executive || null,
          meeting_date: r.meeting_date || null, status: statusFor(r), notes: r.notes || null,
          created_by: req.teamMember.id,
        });
      }
    }
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const { error } = await supabase.from('b2b_records').insert(toInsert.slice(i, i + BATCH));
      if (error) return res.status(400).json({ error: error.message });
      inserted += toInsert.slice(i, i + BATCH).length;
    }
  } else {
    const toInsert = records.map((r) => ({
      client_company_id, target_company: r.target_company, target_contact: r.target_contact || null,
      industry: r.industry || null, country: r.country || null,
      target_position: r.target_position || null, target_email: r.target_email || null,
      target_phone: r.target_phone || null, executive: r.executive || null,
      contacted_at: r.contacted_at || null, status: 'contactado', notes: r.notes || null,
      created_by: req.teamMember.id,
    }));
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const { error } = await supabase.from('b2b_records').insert(toInsert.slice(i, i + BATCH));
      if (error) return res.status(400).json({ error: error.message });
      inserted += toInsert.slice(i, i + BATCH).length;
    }
  }

  res.json({ inserted, updated });
});

// GET /api/b2b/dashboard?client_company_id=
router.get('/dashboard', async (req, res) => {
  const { client_company_id } = req.query;
  if (!client_company_id) return res.status(400).json({ error: 'Falta client_company_id' });

  const [{ data: records, error }, team] = await Promise.all([
    supabase.from('b2b_records').select('*, team_members(full_name)').eq('client_company_id', client_company_id),
    getBitProspectTeam(),
  ]);
  if (error) return res.status(500).json({ error: error.message });
  res.json(computeB2bDashboard(records, team));
});

// GET /api/b2b/leaderboard — rendimiento por persona cruzando TODOS los clientes,
// para comparar el equipo de Outbound en conjunto (no cliente por cliente).
router.get('/leaderboard', async (req, res) => {
  const [{ data: records, error }, team] = await Promise.all([
    supabase.from('b2b_records').select('*, team_members(full_name), companies(name)'),
    getBitProspectTeam(),
  ]);
  if (error) return res.status(500).json({ error: error.message });

  const global = computeB2bDashboard(records, team || []);

  // Además del total, desglosa cada persona por cliente para ver dónde está parada su carga.
  // Se siembra igual con todo el equipo (aunque no tengan registros en ningún cliente todavía).
  const byPersonByClient = {};
  (team || []).forEach((m) => { byPersonByClient[m.full_name] = { name: m.full_name, clients: {} }; });

  records.forEach((r) => {
    const personKey = (r.executive && r.executive.trim()) || r.team_members?.full_name || 'Sin asignar';
    const clientName = r.companies?.name || 'Sin cliente';
    if (!byPersonByClient[personKey]) byPersonByClient[personKey] = { name: personKey, clients: {} };
    if (!byPersonByClient[personKey].clients[clientName]) byPersonByClient[personKey].clients[clientName] = { contacted: 0, meetings: 0 };
    byPersonByClient[personKey].clients[clientName].contacted += 1;
    if (r.meeting_date || r.status === 'reunion_agendada' || r.status === 'reunion_realizada') {
      byPersonByClient[personKey].clients[clientName].meetings += 1;
    }
  });

  res.json({
    ...global,
    by_person_by_client: Object.values(byPersonByClient).map((p) => ({
      name: p.name,
      clients: Object.entries(p.clients).map(([client, stats]) => ({ client, ...stats })),
    })),
  });
});

// POST /api/b2b/clients/:id/export-to-contacts — convierte los registros de un cliente de Bit Prospect
// en Contactos + Empresas reales del CRM, agrupados en una Lista (tag) "Bit Prospect <cliente>"
// para que aparezcan junto a las listas de Apollo/Lusha en el módulo de Listas.
router.post('/clients/:id/export-to-contacts', async (req, res) => {
  const { data: client } = await supabase.from('companies').select('name').eq('id', req.params.id).maybeSingle();
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado.' });

  const { data: records, error: recordsError } = await supabase
    .from('b2b_records').select('*').eq('client_company_id', req.params.id);
  if (recordsError) return res.status(500).json({ error: recordsError.message });

  const listName = `Bit Prospect ${client.name}`;
  const { data: existingTag } = await supabase.from('tags').select('id').ilike('name', listName).maybeSingle();
  let tagId = existingTag?.id;
  if (!tagId) {
    const { data: newTag, error: tagError } = await supabase.from('tags').insert({ name: listName }).select('id').single();
    if (tagError) return res.status(400).json({ error: tagError.message });
    tagId = newTag.id;
  }

  let created = 0;
  let skipped = 0;

  for (const r of records) {
    if (!r.target_company) { skipped++; continue; }

    let companyId;
    const { data: existingCompany } = await supabase.from('companies').select('id').ilike('name', r.target_company).maybeSingle();
    if (existingCompany) {
      companyId = existingCompany.id;
    } else {
      const { data: newCompany, error: companyError } = await supabase
        .from('companies').insert({ name: r.target_company, country: r.country || null, industry: r.industry || null }).select('id').single();
      if (companyError) { skipped++; continue; }
      companyId = newCompany.id;
    }

    const [firstName, ...rest] = (r.target_contact || r.target_company).trim().split(' ');
    const { data: dupe } = await supabase
      .from('contacts').select('id').eq('company_id', companyId).ilike('first_name', firstName).maybeSingle();

    let contactId = dupe?.id;
    if (!contactId) {
      const { data: contact, error: contactError } = await supabase
        .from('contacts')
        .insert({
          first_name: firstName || r.target_company,
          last_name: rest.join(' ') || null,
          position: r.target_position || null,
          email: r.target_email || null,
          phone: r.target_phone || null,
          country: r.country || null,
          company_id: companyId,
          owner_id: req.teamMember.id,
          source: 'bit_prospect',
        })
        .select('id')
        .single();
      if (contactError) { skipped++; continue; }
      contactId = contact.id;
    }

    const { data: alreadyTagged } = await supabase
      .from('taggables').select('tag_id').eq('tag_id', tagId).eq('entity_type', 'contact').eq('entity_id', contactId).maybeSingle();
    if (!alreadyTagged) {
      await supabase.from('taggables').insert({ tag_id: tagId, entity_type: 'contact', entity_id: contactId });
    }
    created++;
  }

  res.json({ created, skipped, list_name: listName });
});

module.exports = router;
