const express = require('express');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { computeB2bDashboard } = require('../utils/b2bDashboard');

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

// GET /api/b2b/records?project_id=&status=   (o client_company_id= para compatibilidad)
router.get('/records', async (req, res) => {
  const { client_company_id, project_id, status } = req.query;
  if (!client_company_id && !project_id) return res.status(400).json({ error: 'Falta project_id o client_company_id' });

  let query = supabase.from('b2b_records').select('*').order('created_at', { ascending: false });
  if (project_id) query = query.eq('project_id', project_id);
  if (client_company_id) query = query.eq('client_company_id', client_company_id);
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/b2b/records/:id/status  { status }  — usado por el tablero de arrastrar y soltar
router.patch('/records/:id/status', async (req, res) => {
  const { status } = req.body;
  const { data, error } = await supabase.from('b2b_records').update({ status, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// POST /api/b2b/projects/:id/share-link — genera (o reutiliza) el link público de solo lectura
router.post('/projects/:id/share-link', async (req, res) => {
  const { data: project } = await supabase.from('projects').select('b2b_share_token').eq('id', req.params.id).single();
  let token = project?.b2b_share_token;
  if (!token) {
    const { data, error } = await supabase.from('projects').update({ is_b2b: true, b2b_share_token: crypto.randomUUID() }).eq('id', req.params.id).select('b2b_share_token').single();
    if (error) return res.status(400).json({ error: error.message });
    token = data.b2b_share_token;
  }
  res.json({ token });
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

// POST /api/b2b/import  { project_id, client_company_id?, mode: 'contactados' | 'reuniones', records: [...] }
// Carga masiva desde CSV. En modo 'reuniones', si el target_company ya existe como
// 'contactado' en ese proyecto, lo actualiza en vez de duplicar la fila.
router.post('/import', async (req, res) => {
  const { project_id, client_company_id, mode, records } = req.body;
  if (!project_id || !Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'Falta project_id o records' });
  }

  await supabase.from('projects').update({ is_b2b: true }).eq('id', project_id);

  let inserted = 0;
  let updated = 0;
  const BATCH = 500;

  if (mode === 'reuniones') {
    const { data: existing } = await supabase
      .from('b2b_records')
      .select('id, target_company')
      .eq('project_id', project_id);
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
          project_id, client_company_id: client_company_id || null,
          target_company: r.target_company, target_contact: r.target_contact || null,
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
      project_id, client_company_id: client_company_id || null,
      target_company: r.target_company, target_contact: r.target_contact || null,
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

// GET /api/b2b/dashboard?project_id=  (o client_company_id= para compatibilidad)
router.get('/dashboard', async (req, res) => {
  const { project_id, client_company_id } = req.query;
  if (!project_id && !client_company_id) return res.status(400).json({ error: 'Falta project_id o client_company_id' });

  let query = supabase.from('b2b_records').select('*');
  if (project_id) query = query.eq('project_id', project_id);
  if (client_company_id) query = query.eq('client_company_id', client_company_id);

  const { data: records, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(computeB2bDashboard(records));
});

module.exports = router;
