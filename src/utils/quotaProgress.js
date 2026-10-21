// Avance de las metas de reuniones por persona (Bit Prospect).
//
// Antes el avance se buscaba en una columna (b2b_records.owner_id) que ninguna migración crea, así que
// la consulta fallaba en silencio y todos aparecían con 0 reuniones. Aquí la persona se saca de lo que SÍ
// guardan los registros, igual que ya hacen el «Rendimiento por persona» y el ranking del equipo:
//   1) el texto del campo «Ejecutivo» (viene de los CSV y de la ficha), reconocido contra los usuarios activos
//   2) si no hay «Ejecutivo», quien cargó el registro (created_by)
// Lo que no se reconoce NO se descarta ni se le asigna a alguien por adivinanza: se devuelve aparte
// (`unmatched`) para que se vea en pantalla, p. ej. el nombre de alguien que todavía no tiene usuario.

function normName(s) {
  return String(s || '')
    .trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Devuelve una función (texto de «Ejecutivo») → id del usuario, o null si no hay una única coincidencia.
// Acepta el nombre completo o una parte que identifique a UNA sola persona («Sofia», «Ana Gabriela»);
// si la parte sirve para dos usuarios («Ana» con dos Ana) no adivina.
function buildMemberMatcher(team) {
  const members = (team || []).map((m) => {
    const full = normName(m.full_name);
    return { id: m.id, full, tokens: full.split(' ').filter(Boolean) };
  });
  const cache = new Map();
  return (text) => {
    const n = normName(text);
    if (!n) return null;
    if (cache.has(n)) return cache.get(n);
    let found = members.filter((m) => m.full === n);
    if (found.length !== 1) {
      const tokens = n.split(' ');
      found = members.filter((m) => tokens.every((t) => m.tokens.includes(t)));
    }
    const id = found.length === 1 ? found[0].id : null;
    cache.set(n, id);
    return id;
  };
}

const inMonth = (value, month) => typeof value === 'string' && value.slice(0, 7) === month;

// records: filas de b2b_records ({ id, executive, created_by, meeting_date, realized_date, companies:{name} }).
// Cuenta, para el mes 'YYYY-MM':
//   scheduled = reuniones con fecha PROGRAMADA dentro del mes   (lo que ya medía el panel)
//   realized  = reuniones con fecha REALIZADA dentro del mes    (el resultado real)
// Una misma fila puede contar en ambas si las dos fechas caen en el mes.
// `ignore`: usuarios activos que NO son del equipo de prospección (p. ej. quien administra el CRM). Si el «Ejecutivo»
// de una reunión nombra a uno de ellos se descarta en silencio — no es un nombre «sin usuario» ni debe avisar.
function computeProgress(records, team, month, ignore = []) {
  const match = buildMemberMatcher([...(team || []), ...ignore]);
  const ignoreIds = new Set(ignore.map((m) => m.id));
  const members = {};
  (team || []).forEach((m) => { members[m.id] = { scheduled: 0, realized: 0, byClient: {} }; });
  const unmatched = {};
  const seen = new Set();

  (records || []).forEach((r, i) => {
    const key = r.id ?? `#${i}`;
    if (seen.has(key)) return; // una fila puede venir por la consulta de programadas y por la de realizadas
    seen.add(key);

    const scheduled = inMonth(r.meeting_date, month);
    const realized = inMonth(r.realized_date, month);
    if (!scheduled && !realized) return;

    const executive = (r.executive || '').trim();
    let memberId = executive ? match(executive) : (r.created_by && members[r.created_by] ? r.created_by : null);
    if (memberId && ignoreIds.has(memberId)) return;

    if (!memberId) {
      const name = executive || '(sin ejecutivo)';
      unmatched[name] ||= { name, scheduled: 0, realized: 0 };
      if (scheduled) unmatched[name].scheduled += 1;
      if (realized) unmatched[name].realized += 1;
      return;
    }

    const bucket = members[memberId];
    if (scheduled) bucket.scheduled += 1;
    if (realized) bucket.realized += 1;
    const client = r.companies?.name || 'Sin cliente';
    bucket.byClient[client] ||= { scheduled: 0, realized: 0 };
    if (scheduled) bucket.byClient[client].scheduled += 1;
    if (realized) bucket.byClient[client].realized += 1;
  });

  return {
    members,
    unmatched: Object.values(unmatched).sort((a, b) => (b.scheduled + b.realized) - (a.scheduled + a.realized)),
  };
}

function previousMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

module.exports = { normName, buildMemberMatcher, computeProgress, previousMonth };
