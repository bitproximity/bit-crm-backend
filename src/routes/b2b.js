const express = require('express');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { requirePage } = require('../middleware/pagePermissions');
const { computeB2bDashboard } = require('../utils/b2bDashboard');

const router = express.Router();
router.use(requireAuth);
router.use(requirePage('b2b'));

// GET /api/b2b/clients — empresas marcadas como clientes del servicio
router.get('/clients', async (req, res) => {
  const { data, error } = await supabase
    .from('companies')
    .select('id, name, b2b_share_token')
    .eq('is_b2b_client', true)
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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

// POST /api/b2b/import  { client_company_id, mode: 'contactados' | 'reuniones', records: [...] }
// Carga masiva desde CSV. En modo 'reuniones', si el target_company ya existe como
// 'contactado' para ese cliente, lo actualiza en vez de duplicar la fila.
router.post('/import', async (req, res) => {
  const { client_company_id, mode, records } = req.body;
  if (!client_company_id || !Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'Falta client_company_id o records' });
  }

  let inserted = 0;
  let updated = 0;
  const BATCH = 500;

  if (mode === 'reuniones') {
    const { data: existing } = await supabase
      .from('b2b_records')
      .select('id, target_company')
      .eq('client_company_id', client_company_id);
    const existingMap = new Map((existing || []).map((r) => [r.target_company.toLowerCase().trim(), r.id]));

    const toInsert = [];
    for (const r of records) {
      const key = (r.target_company || '').toLowerCase().trim();
      if (key && existingMap.has(key)) {
        await supabase.from('b2b_records').update({
          status: 'reunion_agendada',
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
          meeting_date: r.meeting_date || null, status: 'reunion_agendada', notes: r.notes || null,
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

  const { data: records, error } = await supabase.from('b2b_records').select('*, team_members(full_name)').eq('client_company_id', client_company_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(computeB2bDashboard(records));
});

// GET /api/b2b/leaderboard — rendimiento por persona cruzando TODOS los clientes,
// para comparar el equipo de Outbound en conjunto (no cliente por cliente).
router.get('/leaderboard', async (req, res) => {
  const { data: records, error } = await supabase.from('b2b_records').select('*, team_members(full_name), companies(name)');
  if (error) return res.status(500).json({ error: error.message });

  const global = computeB2bDashboard(records);

  // Además del total, desglosa cada persona por cliente para ver dónde está parada su carga.
  const byPersonByClient = {};
  records.forEach((r) => {
    const personKey = r.created_by || 'sin_asignar';
    const personName = r.team_members?.full_name || 'Sin asignar';
    const clientName = r.companies?.name || 'Sin cliente';
    if (!byPersonByClient[personKey]) byPersonByClient[personKey] = { name: personName, clients: {} };
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

module.exports = router;
