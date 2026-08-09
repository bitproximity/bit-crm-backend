const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/b2b/clients — empresas marcadas como clientes del servicio
router.get('/clients', async (req, res) => {
  const { data, error } = await supabase
    .from('companies')
    .select('id, name')
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

// POST /api/b2b/records — crear un registro suelto (uso manual desde el detalle)
router.post('/records', async (req, res) => {
  const { data, error } = await supabase.from('b2b_records').insert({ ...req.body, created_by: req.teamMember.id }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

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
    // Intenta emparejar por target_company (case-insensitive) para no duplicar
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
          notes: r.notes || undefined,
          updated_at: new Date().toISOString(),
        }).eq('id', existingMap.get(key));
        updated++;
      } else {
        toInsert.push({
          client_company_id, target_company: r.target_company, target_contact: r.target_contact || null,
          industry: r.industry || null, country: r.country || null,
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

  const { data: records, error } = await supabase.from('b2b_records').select('*').eq('client_company_id', client_company_id);
  if (error) return res.status(500).json({ error: error.message });

  const totalContacted = records.length;
  const meetings = records.filter((r) => r.meeting_date || r.status === 'reunion_agendada' || r.status === 'reunion_realizada');
  const totalMeetings = meetings.length;
  const conversionRate = totalContacted ? Math.round((totalMeetings / totalContacted) * 100) : 0;

  const byIndustry = {};
  const byCountry = {};
  const byMonth = {};

  meetings.forEach((r) => {
    const industry = r.industry || 'Sin especificar';
    const country = r.country || 'Sin especificar';
    byIndustry[industry] = (byIndustry[industry] || 0) + 1;
    byCountry[country] = (byCountry[country] || 0) + 1;
    if (r.meeting_date) {
      const month = r.meeting_date.slice(0, 7); // YYYY-MM
      byMonth[month] = (byMonth[month] || 0) + 1;
    }
  });

  const thisMonthKey = new Date().toISOString().slice(0, 7);
  const meetingsThisMonth = byMonth[thisMonthKey] || 0;

  res.json({
    total_contacted: totalContacted,
    total_meetings: totalMeetings,
    conversion_rate: conversionRate,
    meetings_this_month: meetingsThisMonth,
    by_industry: Object.entries(byIndustry).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    by_country: Object.entries(byCountry).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    by_month: Object.entries(byMonth).map(([month, count]) => ({ month, count })).sort((a, b) => a.month.localeCompare(b.month)),
  });
});

module.exports = router;
