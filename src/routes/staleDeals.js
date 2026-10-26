const express = require('express');
const supabase = require('../config/supabase');
const { fetchAll, selectIn } = require('../utils/fetchAll');
const { memo } = require('../utils/memo');
const { requireAuth, requireRole } = require('../middleware/auth');
const { createNotification } = require('../utils/notify');
const { logAudit } = require('../utils/audit');
const { todayInTz } = require('../utils/businessDate');
const { computeStale, REMINDER_PREFIX } = require('../utils/staleDeals');

const router = express.Router();
// Ven y reactivan TODOS los tratos abiertos: administración y operaciones. El socio externo (solo ve su embudo) y
// prospección (sin acceso a tratos) quedan fuera, igual que en el resto de la sección de tratos.
router.use(requireAuth);
router.use(requireRole('admin', 'operaciones'));

const clampDays = (v) => Math.min(365, Math.max(1, Math.round(Number(v)) || 14));

// Carga los datos y calcula la lista. Se usa también desde el aviso diario.
async function loadStale({ days = 14, pipeline_id = null, owner_id = null } = {}) {
  let dealsQuery = supabase.from('deals')
    .select('id, title, value, currency, probability, stage_id, pipeline_id, owner_id, created_at, companies(name), pipeline_stages(name), pipelines(name), team_members(full_name)')
    .eq('status', 'abierto');
  if (pipeline_id) dealsQuery = dealsQuery.eq('pipeline_id', pipeline_id);
  if (owner_id) dealsQuery = dealsQuery.eq('owner_id', owner_id);

  const [deals, acts, hist, tasks, rates] = await Promise.all([
    fetchAll(dealsQuery),
    fetchAll(supabase.from('activities').select('entity_id, occurred_at, type, summary').eq('entity_type', 'deal')),
    fetchAll(supabase.from('deal_stage_history').select('deal_id, changed_at')),
    fetchAll(supabase.from('tasks').select('deal_id, title, status').not('deal_id', 'is', null).neq('status', 'completada')),
    supabase.from('exchange_rates').select('*'),
  ]);
  const failed = [deals, acts, hist, tasks].find((r) => r.error);
  if (failed) throw new Error(failed.error.message);
  return computeStale({ deals: deals.data || [], activities: acts.data || [], history: hist.data || [], tasks: tasks.data || [], rates: rates.data || [], days });
}

// GET /api/stale-deals?days=14&pipeline_id=&owner_id=
router.get('/', async (req, res) => {
  try {
    const days = clampDays(req.query.days);
    const { pipeline_id = null, owner_id = null } = req.query;
    res.json(await memo(`stale:${days}:${pipeline_id}:${owner_id}`, 30000, () => loadStale({ days, pipeline_id, owner_id })));
  } catch (err) {
    res.status(500).json({ error: `No se pudo calcular la lista de tratos estáticos: ${err.message}` });
  }
});

// Inserta tolerando columnas que no existan en tu base (el esquema de tareas ha ido creciendo).
async function insertTasksTolerant(rows) {
  let body = rows.map((r) => ({ ...r }));
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await supabase.from('tasks').insert(body).select('id, deal_id, assignee_id');
    if (!result.error) return result;
    const m = /Could not find the '(\w+)' column/.exec(result.error.message || '');
    if (!m || !(m[1] in body[0])) return result;
    body = body.map(({ [m[1]]: _drop, ...rest }) => rest); // eslint-disable-line no-unused-vars
  }
  return { error: { message: 'No se pudieron crear los recordatorios.' } };
}

// POST /api/stale-deals/remind  { deal_ids: [...], due_in_days?: 1 }
// Crea una tarea «Reactivar: <trato>» para el responsable de cada trato (o para quien la pide, si no tiene responsable).
// No duplica: un trato que ya tiene un recordatorio abierto se omite.
router.post('/remind', async (req, res) => {
  const ids = Array.isArray(req.body?.deal_ids) ? [...new Set(req.body.deal_ids.filter(Boolean))] : [];
  if (ids.length === 0 || ids.length > 200) return res.status(400).json({ error: 'Envía entre 1 y 200 tratos.' });
  const dueIn = Math.min(30, Math.max(0, Math.round(Number(req.body?.due_in_days ?? 1))));

  try {
    const [dealsRes, tasksRes] = await Promise.all([
      selectIn(() => supabase.from('deals').select('id, title, status, owner_id'), 'id', ids),
      selectIn(() => supabase.from('tasks').select('id, deal_id, title, status').neq('status', 'completada'), 'deal_id', ids),
    ]);
    const failed = [dealsRes, tasksRes].find((r) => r.error);
    if (failed) throw new Error(failed.error.message);
    const deals = dealsRes.data;
    const open = deals.filter((d) => d.status === 'abierto');
    const already = new Set(tasksRes.data.filter((t) => String(t.title || '').startsWith(REMINDER_PREFIX)).map((t) => t.deal_id));
    const targets = open.filter((d) => !already.has(d.id));

    const dueDay = new Date(`${todayInTz()}T14:00:00Z`); // 9:00 a. m. de Panamá
    dueDay.setUTCDate(dueDay.getUTCDate() + dueIn);
    const rows = targets.map((d) => ({
      title: `${REMINDER_PREFIX}${d.title}`.slice(0, 200),
      description: 'Este trato lleva tiempo sin movimiento. Escribe o llama al contacto, registra el resultado en el trato y define el siguiente paso (o ciérralo como perdido si ya no avanza).',
      deal_id: d.id, assignee_id: d.owner_id || req.teamMember.id, due_date: dueDay.toISOString(),
      priority: 'alta', status: 'pendiente', created_by: req.teamMember.id,
    }));

    let created = 0;
    if (rows.length) {
      const { data, error } = await insertTasksTolerant(rows);
      if (error) return res.status(400).json({ error: error.message });
      created = (data || []).length;
      // Un solo aviso por persona (no uno por tarea)
      const perAssignee = new Map();
      (data || []).forEach((t) => perAssignee.set(t.assignee_id, (perAssignee.get(t.assignee_id) || 0) + 1));
      for (const [assignee, n] of perAssignee) {
        if (assignee && assignee !== req.teamMember.id) {
          await createNotification({ recipient_id: assignee, type: 'task_assigned', title: `Tienes ${n} recordatorio${n === 1 ? '' : 's'} para reactivar tratos`, link: '/tasks' });
        }
      }
      await logAudit('deal', targets[0].id, 'updated', req.teamMember.id, { stale_reminders: { created } });
    }
    res.status(201).json({ created, skipped: ids.length - created, already_had_reminder: already.size, not_open: deals.length - open.length });
  } catch (err) {
    res.status(500).json({ error: `No se pudieron crear los recordatorios: ${err.message}` });
  }
});

// ── Depuración en bloque ────────────────────────────────────────────────────────────────────────────────────────
// Con cientos de tratos sin responsable y sin movimiento, hay que poder ordenarlos de a muchos: asignarles un responsable
// o cerrar como perdidos los que ya no van a avanzar. Solo trabajan sobre tratos ABIERTOS, por lotes, y quedan en la auditoría.
const CHUNK = 150;
const cleanIds = (v) => (Array.isArray(v) ? [...new Set(v.filter(Boolean))] : []);

// POST /api/stale-deals/assign  { deal_ids: [...], owner_id }
router.post('/assign', async (req, res) => {
  const ids = cleanIds(req.body?.deal_ids);
  const ownerId = req.body?.owner_id;
  if (ids.length === 0 || ids.length > 1000) return res.status(400).json({ error: 'Envía entre 1 y 1000 tratos.' });
  if (!ownerId) return res.status(400).json({ error: 'Falta el responsable.' });
  try {
    const { data: owner, error: ownerErr } = await supabase.from('team_members').select('id, full_name, active').eq('id', ownerId).maybeSingle();
    if (ownerErr) throw new Error(ownerErr.message);
    if (!owner || owner.active === false) return res.status(400).json({ error: 'Ese responsable no existe o está inactivo.' });

    let updated = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data, error } = await supabase.from('deals').update({ owner_id: ownerId, updated_at: new Date().toISOString() })
        .in('id', ids.slice(i, i + CHUNK)).eq('status', 'abierto').select('id');
      if (error) throw new Error(error.message);
      updated += (data || []).length;
    }
    if (updated) {
      await logAudit('deal', ids[0], 'updated', req.teamMember.id, { bulk_assign: { owner: owner.full_name, deals: updated } });
      if (ownerId !== req.teamMember.id) await createNotification({ recipient_id: ownerId, type: 'deal_assigned', title: `Te asignaron ${updated} trato${updated === 1 ? '' : 's'} para reactivar`, link: '/stale-deals' });
    }
    res.json({ updated, skipped: ids.length - updated, owner: owner.full_name });
  } catch (err) {
    res.status(500).json({ error: `No se pudo asignar el responsable: ${err.message}` });
  }
});

// POST /api/stale-deals/close-lost  { deal_ids: [...], reason }  — solo administración
router.post('/close-lost', requireRole('admin'), async (req, res) => {
  const ids = cleanIds(req.body?.deal_ids);
  const reason = String(req.body?.reason || '').trim().slice(0, 120) || 'Dejó de responder';
  if (ids.length === 0 || ids.length > 1000) return res.status(400).json({ error: 'Envía entre 1 y 1000 tratos.' });
  try {
    const closed = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data, error } = await supabase.from('deals')
        .update({ status: 'perdido', closed_at: new Date().toISOString(), lost_reason: reason, updated_at: new Date().toISOString() })
        .in('id', ids.slice(i, i + CHUNK)).eq('status', 'abierto').select('id, owner_id');
      if (error) throw new Error(error.message);
      closed.push(...(data || []));
    }
    for (const d of closed) await logAudit('deal', d.id, 'status_changed', req.teamMember.id, { status: { to: 'perdido' }, lost_reason: reason, bulk: true });
    const perOwner = new Map();
    closed.forEach((d) => { if (d.owner_id && d.owner_id !== req.teamMember.id) perOwner.set(d.owner_id, (perOwner.get(d.owner_id) || 0) + 1); });
    for (const [owner, n] of perOwner) await createNotification({ recipient_id: owner, type: 'deal_lost', title: `${n} de tus tratos se cerraron como perdidos por falta de movimiento`, link: '/deals-list' });
    res.json({ closed: closed.length, skipped: ids.length - closed.length, reason });
  } catch (err) {
    res.status(500).json({ error: `No se pudieron cerrar los tratos: ${err.message}` });
  }
});

module.exports = router;
module.exports.loadStale = loadStale;
