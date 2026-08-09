const express = require('express');
const supabase = require('../config/supabase');
const { computeB2bDashboard } = require('../utils/b2bDashboard');

const router = express.Router();

// GET /api/public/b2b/:token — reporte de solo lectura, sin login, para compartir con el cliente
router.get('/:token', async (req, res) => {
  const { token } = req.params;

  const { data: project, error } = await supabase
    .from('projects')
    .select('id, name, companies(name)')
    .eq('b2b_share_token', token)
    .single();

  if (error || !project) return res.status(404).json({ error: 'Link no válido o expirado.' });

  const { data: records } = await supabase
    .from('b2b_records')
    .select('target_company, target_contact, industry, country, meeting_date, status')
    .eq('project_id', project.id);

  res.json({
    project_name: project.name,
    client_name: project.companies?.name || null,
    ...computeB2bDashboard(records || []),
    records: (records || []).sort((a, b) => (b.meeting_date || '').localeCompare(a.meeting_date || '')),
  });
});

module.exports = router;
