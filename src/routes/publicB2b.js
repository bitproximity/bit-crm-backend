const express = require('express');
const supabase = require('../config/supabase');
const { computeB2bDashboard } = require('../utils/b2bDashboard');

const router = express.Router();

// GET /api/public/b2b/:token — reporte de solo lectura, sin login, para compartir con el cliente
router.get('/:token', async (req, res) => {
  const { token } = req.params;

  const { data: company, error } = await supabase
    .from('companies')
    .select('id, name')
    .eq('b2b_share_token', token)
    .single();

  if (error || !company) return res.status(404).json({ error: 'Link no válido o expirado.' });

  const { data: records } = await supabase
    .from('b2b_records')
    .select('target_company, target_contact, target_position, industry, country, city, meeting_date, status')
    .eq('client_company_id', company.id);

  res.json({
    client_name: company.name,
    ...computeB2bDashboard(records || []),
    records: (records || []).sort((a, b) => (b.meeting_date || '').localeCompare(a.meeting_date || '')),
  });
});

module.exports = router;
