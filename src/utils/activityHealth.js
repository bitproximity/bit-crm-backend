// Por vendedor: tratos abiertos, cuántos no tienen próxima actividad y cuántos la tienen vencida
// (todos los embudos). Lo usan el cuadro del Dashboard y el resumen semanal por correo.
const supabase = require('../config/supabase');
const { fetchAll, selectIn } = require('./fetchAll');

function summarizeActivityHealth(open, pending, now = Date.now()) {
  const next = new Map();
  for (const a of pending || []) {
    const cur = next.get(a.entity_id);
    if (!cur || a.due_date < cur) next.set(a.entity_id, a.due_date);
  }
  const byOwner = new Map();
  for (const d of open || []) {
    const key = d.owner_id || 'none';
    if (!byOwner.has(key)) byOwner.set(key, { owner_id: d.owner_id || null, name: d.team_members?.full_name || 'Sin responsable', open: 0, none: 0, late: 0 });
    const r = byOwner.get(key);
    r.open++;
    const due = next.get(d.id);
    if (!due) r.none++;
    else if (new Date(due).getTime() < now) r.late++;
  }
  const rows = [...byOwner.values()]
    .map((r) => ({ ...r, pending: r.none + r.late, pct: r.open ? Math.round(((r.none + r.late) / r.open) * 100) : 0 }))
    .sort((a, b) => b.pending - a.pending || a.name.localeCompare(b.name));
  return { rows, total_open: (open || []).length, total_pending: rows.reduce((n, r) => n + r.pending, 0) };
}

async function loadActivityHealth() {
  const { data: open, error } = await fetchAll(
    supabase.from('deals').select('id, owner_id, team_members(full_name)').eq('status', 'abierto')
  );
  if (error) throw new Error(error.message);
  const { data: pending, error: actErr } = await selectIn(
    () => supabase.from('activities').select('entity_id, due_date').eq('entity_type', 'deal').eq('done', false)
      .not('due_date', 'is', null).or('type.is.null,type.neq.nota'),
    'entity_id',
    (open || []).map((d) => d.id)
  );
  if (actErr) throw new Error(actErr.message);
  return summarizeActivityHealth(open, pending);
}

module.exports = { loadActivityHealth, summarizeActivityHealth };
