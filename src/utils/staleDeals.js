// Tratos ESTÁTICOS: abiertos, sin movimiento real en N días.
//
// El aviso que existía (automatizaciones «deal_stale») solo funcionaba si alguien creaba una regla, miraba
// `updated_at` (que cambia con cualquier edición, hasta una automática) y no había dónde VER la lista.
// Aquí «movimiento» es lo que de verdad indica que alguien está trabajando el trato:
//   · una actividad registrada (nota, llamada, reunión, correo) que ya ocurrió
//   · un cambio de etapa
//   · y, si no hay nada de eso, la fecha de creación
// Se ordena por dinero en juego (USD), para reactivar primero lo que más vale.
const { buildConverter, round2 } = require('./currency');

const DAY = 86400000;
const REMINDER_PREFIX = 'Reactivar: ';

function computeStale({ deals = [], activities = [], history = [], tasks = [], rates = [], now = new Date(), days = 14 }) {
  const conv = buildConverter(rates);
  const nowMs = now.getTime();

  const lastAct = new Map();   // trato → { at, type, summary }
  for (const a of activities) {
    const t = new Date(a.occurred_at).getTime();
    if (!a.entity_id || Number.isNaN(t) || t > nowMs) continue; // lo agendado a futuro todavía no es movimiento
    const cur = lastAct.get(a.entity_id);
    if (!cur || t > cur.ms) lastAct.set(a.entity_id, { ms: t, at: a.occurred_at, type: a.type, summary: a.summary });
  }
  const lastStage = new Map();
  for (const h of history) {
    const t = new Date(h.changed_at).getTime();
    if (!h.deal_id || Number.isNaN(t) || t > nowMs) continue;
    if (!lastStage.has(h.deal_id) || t > lastStage.get(h.deal_id)) lastStage.set(h.deal_id, t);
  }
  const openTasks = new Map();
  for (const t of tasks) {
    if (!t.deal_id || t.status === 'completada') continue;
    const cur = openTasks.get(t.deal_id) || { count: 0, reminder: false };
    cur.count += 1;
    if (String(t.title || '').startsWith(REMINDER_PREFIX)) cur.reminder = true;
    openTasks.set(t.deal_id, cur);
  }

  const rows = [];
  for (const d of deals) {
    const candidates = [{ ms: new Date(d.created_at).getTime(), kind: 'creación' }];
    if (lastStage.has(d.id)) candidates.push({ ms: lastStage.get(d.id), kind: 'cambio de etapa' });
    if (lastAct.has(d.id)) candidates.push({ ms: lastAct.get(d.id).ms, kind: 'actividad' });
    const last = candidates.filter((c) => !Number.isNaN(c.ms)).sort((a, b) => b.ms - a.ms)[0];
    if (!last) continue;
    const idle = Math.floor((nowMs - last.ms) / DAY);
    if (idle < days) continue;
    const valueUsd = round2(conv.toUsd(d.value, d.currency));
    const act = lastAct.get(d.id);
    rows.push({
      id: d.id, title: d.title, company: d.companies?.name || null, owner_id: d.owner_id || null, owner: d.team_members?.full_name || null,
      pipeline: d.pipelines?.name || null, stage: d.pipeline_stages?.name || null,
      value: Number(d.value || 0), currency: d.currency, value_usd: valueUsd, probability: d.probability ?? null,
      last_touch: new Date(last.ms).toISOString(), last_touch_kind: last.kind, days_idle: idle,
      last_activity: act ? { type: act.type, summary: act.summary, at: act.at } : null,
      open_tasks: openTasks.get(d.id)?.count || 0, has_reminder: !!openTasks.get(d.id)?.reminder,
      priority: valueUsd >= 5000 ? 'alta' : valueUsd >= 1000 ? 'media' : 'baja',
    });
  }
  rows.sort((a, b) => b.value_usd - a.value_usd || b.days_idle - a.days_idle);

  const bucket = (d) => (d < 30 ? '14_29' : d < 60 ? '30_59' : d < 90 ? '60_89' : '90_mas');
  const buckets = { '14_29': { count: 0, value_usd: 0 }, '30_59': { count: 0, value_usd: 0 }, '60_89': { count: 0, value_usd: 0 }, '90_mas': { count: 0, value_usd: 0 } };
  const owners = new Map();
  for (const r of rows) {
    const b = buckets[bucket(r.days_idle)]; b.count += 1; b.value_usd += r.value_usd;
    const k = r.owner_id || 'sin';
    const o = owners.get(k) || { owner_id: r.owner_id, owner: r.owner || 'Sin responsable', count: 0, value_usd: 0 };
    o.count += 1; o.value_usd += r.value_usd; owners.set(k, o);
  }
  Object.values(buckets).forEach((b) => { b.value_usd = round2(b.value_usd); });

  return {
    days, generated_at: now.toISOString(),
    summary: {
      count: rows.length, value_usd: round2(rows.reduce((n, r) => n + r.value_usd, 0)),
      without_next_step: rows.filter((r) => r.open_tasks === 0).length, with_reminder: rows.filter((r) => r.has_reminder).length,
      buckets,
      by_owner: [...owners.values()].map((o) => ({ ...o, value_usd: round2(o.value_usd) })).sort((a, b) => b.value_usd - a.value_usd),
    },
    deals: rows,
    missing_rates: [...conv.missing],
  };
}

module.exports = { computeStale, REMINDER_PREFIX };
