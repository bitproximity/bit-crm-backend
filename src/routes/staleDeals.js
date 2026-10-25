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

module.exports = router;
module.exports.loadStale = loadStale;
