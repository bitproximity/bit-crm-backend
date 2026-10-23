const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { isExcludedFromBitProspect } = require('../utils/bitProspectTeam');
const { fetchAll } = require('../utils/fetchAll');
const { monthInTz } = require('../utils/businessDate');
const { computeProgress, previousMonth } = require('../utils/quotaProgress');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const router = express.Router();
router.use(requireAuth);

function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { start, end };
}

// GET /api/quotas?month=YYYY-MM — cada persona activa del equipo de Bit Prospect con su meta del mes
// (si la tiene) y el avance real: reuniones AGENDADAS (fecha programada en el mes) y REALIZADAS (fecha
// realizada en el mes), en general y por cliente. Incluye la meta del mes anterior (para copiarla) y las
// reuniones cuyo «Ejecutivo» no coincide con ningún usuario activo (`unmatched`), que antes se perdían.
const RECORD_COLS = 'id, executive, created_by, meeting_date, realized_date, companies(name)';

router.get('/', async (req, res) => {
  const month = req.query.month || monthInTz();
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'Mes inválido: usa el formato AAAA-MM.' });
  const { start, end } = monthBounds(month);

  const [teamRes, quotasRes, prevRes, scheduledRes, realizedRes] = await Promise.all([
    supabase.from('team_members').select('id, full_name').eq('active', true),
    supabase.from('sales_quotas').select('*').eq('month', month),
    supabase.from('sales_quotas').select('team_member_id, target_meetings').eq('month', previousMonth(month)).eq('client_name', ''),
    fetchAll(supabase.from('b2b_records').select(RECORD_COLS).gte('meeting_date', start).lt('meeting_date', end)),
    fetchAll(supabase.from('b2b_records').select(RECORD_COLS).gte('realized_date', `${start}T00:00:00Z`).lt('realized_date', `${end}T00:00:00Z`)),
  ]);
  // Si algo falla se dice (antes se devolvían ceros como si nadie tuviera reuniones).
  const failed = [teamRes, quotasRes, scheduledRes, realizedRes].find((r) => r.error);
  if (failed) return res.status(500).json({ error: `No se pudo calcular el avance de las metas: ${failed.error.message}` });

  // Mismo criterio que /leaderboard: quien no hace prospección/reuniones para Bit Prospect
  // (soporte técnico, un socio externo) no debería aparecer con una meta de reuniones.
  const team = (teamRes.data || []).filter((m) => !isExcludedFromBitProspect(m.full_name));
  const ignored = (teamRes.data || []).filter((m) => isExcludedFromBitProspect(m.full_name));
  const quotas = quotasRes.data || [];
  const previous = new Map((prevRes.data || []).map((q) => [q.team_member_id, q.target_meetings]));
  const { members, unmatched } = computeProgress([...(scheduledRes.data || []), ...(realizedRes.data || [])], team, month, ignored);

  const rows = team
    .map((m) => {
      const mine = quotas.filter((q) => q.team_member_id === m.id);
      const general = mine.find((q) => !q.client_name?.trim()) || null;
      const progress = members[m.id] || { scheduled: 0, realized: 0, byClient: {} };
      return {
        team_member_id: m.id,
        full_name: m.full_name,
        target: general?.target_meetings ?? null,
        quota_id: general?.id ?? null,
        scheduled: progress.scheduled,
        realized: progress.realized,
        actual: progress.scheduled, // compatibilidad con la pantalla anterior
        previous_target: previous.get(m.id) ?? null,
        by_client: mine.filter((q) => q.client_name?.trim()).map((q) => ({
          client_name: q.client_name,
          target: q.target_meetings,
          actual: progress.byClient[q.client_name]?.scheduled || 0,
          realized: progress.byClient[q.client_name]?.realized || 0,
          quota_id: q.id,
        })),
      };
    })
    .sort((a, b) => a.full_name.localeCompare(b.full_name, 'es'));

  res.json({
    month,
    rows,
    unmatched,
    totals: {
      target: rows.reduce((n, r) => n + (r.target || 0), 0),
      scheduled: rows.reduce((n, r) => n + r.scheduled, 0),
      realized: rows.reduce((n, r) => n + r.realized, 0),
    },
  });
});

// POST /api/quotas/bulk  { month, goals: [{ team_member_id, target_meetings }] } — asigna las metas generales de
// varias personas de una vez. Un valor vacío o 0 quita la meta de esa persona en ese mes.
router.post('/bulk', requireRole('admin'), async (req, res) => {
  const { month, goals } = req.body || {};
  if (!MONTH_RE.test(String(month || ''))) return res.status(400).json({ error: 'Mes inválido: usa el formato AAAA-MM.' });
  if (!Array.isArray(goals) || goals.length === 0 || goals.length > 100) return res.status(400).json({ error: 'Envía entre 1 y 100 metas.' });

  const toSave = []; const toRemove = [];
  for (const g of goals) {
    if (!g || !g.team_member_id) return res.status(400).json({ error: 'Cada meta necesita team_member_id.' });
    const raw = g.target_meetings;
    if (raw === null || raw === undefined || raw === '' || Number(raw) === 0) { toRemove.push(g.team_member_id); continue; }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 999) return res.status(400).json({ error: 'Cada meta debe ser un número entero entre 1 y 999 (o vacío para quitarla).' });
    toSave.push({ team_member_id: g.team_member_id, month, target_meetings: n, client_name: '', created_by: req.teamMember.id });
  }

  let saved = [];
  if (toSave.length) {
    const { data, error } = await supabase.from('sales_quotas').upsert(toSave, { onConflict: 'team_member_id,month,client_name' }).select('id, team_member_id, target_meetings');
    if (error) return res.status(400).json({ error: error.message });
    saved = data || [];
  }
  if (toRemove.length) {
    const { error } = await supabase.from('sales_quotas').delete().eq('month', month).eq('client_name', '').in('team_member_id', toRemove);
    if (error) return res.status(400).json({ error: error.message });
  }
  for (const q of saved) await logAudit('sales_quota', q.id, 'updated', req.teamMember.id, { month, target_meetings: { to: q.target_meetings } });
  res.json({ month, saved: saved.length, removed: toRemove.length });
});

// POST /api/quotas  { team_member_id, month, target_meetings, client_name? } — crea o
// actualiza (misma persona+mes+cliente = se pisa, no se duplica).
router.post('/', requireRole('admin'), async (req, res) => {
  const { team_member_id, month, target_meetings, client_name } = req.body;
  if (!team_member_id || !month || target_meetings === undefined) {
    return res.status(400).json({ error: 'Faltan team_member_id, month o target_meetings' });
  }
  if (!MONTH_RE.test(String(month)) || !Number.isInteger(Number(target_meetings)) || Number(target_meetings) < 1 || Number(target_meetings) > 999) {
    return res.status(400).json({ error: 'Mes inválido (AAAA-MM) o meta fuera de 1–999.' });
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
