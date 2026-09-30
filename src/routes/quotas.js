const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { BIT_PROSPECT_TEAM_EXCLUDE } = require('../utils/bitProspectTeam');

const router = express.Router();
router.use(requireAuth);

function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { start, end };
}

// GET /api/quotas?month=YYYY-MM — cada vendedor activo con su meta del mes (si la tiene) y
// el avance real (reuniones agendadas en Bit Prospect ese mes), general y por cliente.
router.get('/', async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const { start, end } = monthBounds(month);

  const [{ data: rawTeam }, { data: quotas }, { data: records }] = await Promise.all([
    supabase.from('team_members').select('id, full_name').eq('active', true),
    supabase.from('sales_quotas').select('*').eq('month', month),
    supabase.from('b2b_records').select('owner_id, executive, meeting_date, companies(name)').gte('meeting_date', start).lt('meeting_date', end),
  ]);
  // Mismo criterio que /leaderboard: quien no hace prospección/reuniones para Bit Prospect
  // (soporte técnico, un socio externo) no debería aparecer con una meta de reuniones.
  const team = (rawTeam || []).filter((m) => !BIT_PROSPECT_TEAM_EXCLUDE.includes(m.full_name));

  // El equipo de Bit Prospect a veces carga registros con "executive" (texto libre) en vez
  // de dejar que quede por owner_id — se cuenta por owner_id cuando existe, y si no, por
  // coincidencia de nombre con "executive", igual que ya hace /leaderboard.
  const countsByMember = {}; // team_member_id -> { total, byClient: {client: n} }
  (records || []).forEach((r) => {
    const clientName = r.companies?.name || 'Sin cliente';
    const memberId = r.owner_id;
    if (!memberId) return;
    countsByMember[memberId] ||= { total: 0, byClient: {} };
    countsByMember[memberId].total += 1;
    countsByMember[memberId].byClient[clientName] = (countsByMember[memberId].byClient[clientName] || 0) + 1;
  });

  const rows = (team || []).map((m) => {
    const memberQuotas = (quotas || []).filter((q) => q.team_member_id === m.id);
    const general = memberQuotas.find((q) => !q.client_name?.trim()) || null;
    const byClient = memberQuotas.filter((q) => q.client_name?.trim()).map((q) => ({
      client_name: q.client_name,
      target: q.target_meetings,
      actual: countsByMember[m.id]?.byClient[q.client_name] || 0,
      quota_id: q.id,
    }));
    return {
      team_member_id: m.id,
      full_name: m.full_name,
      target: general?.target_meetings ?? null,
      actual: countsByMember[m.id]?.total || 0,
      quota_id: general?.id ?? null,
      by_client: byClient,
    };
  });

  res.json({ month, rows });
});

// POST /api/quotas  { team_member_id, month, target_meetings, client_name? } — crea o
// actualiza (misma persona+mes+cliente = se pisa, no se duplica).
router.post('/', requireRole('admin'), async (req, res) => {
  const { team_member_id, month, target_meetings, client_name } = req.body;
  if (!team_member_id || !month || target_meetings === undefined) {
    return res.status(400).json({ error: 'Faltan team_member_id, month o target_meetings' });
  }
  const { data, error } = await supabase
    .from('sales_quotas')
    .upsert(
      { team_member_id, month, target_meetings: Number(target_meetings), client_name: client_name?.trim() || '', created_by: req.teamMember.id },
      { onConflict: 'team_member_id,month,client_name' }
    )
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  await logAudit('sales_quota', data.id, 'created', req.teamMember.id);
  res.status(201).json(data);
});

// DELETE /api/quotas/:id
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { error } = await supabase.from('sales_quotas').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
});

module.exports = router;
