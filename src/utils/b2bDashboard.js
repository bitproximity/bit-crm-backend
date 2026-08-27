function normalizeCountry(c) {
  return (c || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Distancia de edición (Levenshtein) entre dos strings — cuántas letras hay que
// cambiar/agregar/quitar para pasar de una a la otra. Se usa para agrupar cargos que
// son "casi" el mismo texto (errores de tipeo), no solo mayúsculas/tildes distintas.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[n];
}

function normalizePosition(p) {
  return (p || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
}

// Agrupa cargos "parecidos" en una sola categoría — cubre mayúsculas/tildes (por la
// normalización) y errores de tipeo reales (por la distancia de edición), sin necesitar
// que el usuario escriba el cargo exactamente igual cada vez. El umbral de similitud
// escala con el largo del texto: 1 letra distinta cada ~6 caracteres, tope de 3.
function groupSimilarPositions(records) {
  const clusters = []; // [{ normalized, label, count }]
  records.forEach((r) => {
    const raw = r.target_position?.trim();
    if (!raw) {
      const existing = clusters.find((c) => c.normalized === '');
      if (existing) existing.count += 1;
      else clusters.push({ normalized: '', label: 'Sin especificar', count: 1 });
      return;
    }
    const norm = normalizePosition(raw);
    let match = clusters.find((c) => c.normalized === norm);
    if (!match) {
      const threshold = Math.min(3, Math.max(1, Math.floor(norm.length / 6)));
      match = clusters.find((c) => c.normalized && Math.abs(c.normalized.length - norm.length) <= threshold && levenshtein(c.normalized, norm) <= threshold);
    }
    if (match) {
      match.count += 1;
      // Se queda con la variante más común como etiqueta a mostrar — no importa cuál
      // llegó primero, sino cuál es la forma que más gente usó para escribirlo.
      match.variants = match.variants || {};
      match.variants[raw] = (match.variants[raw] || 0) + 1;
      const best = Object.entries(match.variants).sort((a, b) => b[1] - a[1])[0][0];
      match.label = best;
    } else {
      clusters.push({ normalized: norm, label: raw, count: 1, variants: { [raw]: 1 } });
    }
  });
  return clusters.map(({ label, count }) => ({ name: label, count })).sort((a, b) => b.count - a.count);
}

function computeB2bDashboard(records, teamMembers = []) {
  const totalContacted = records.length;
  const meetings = records.filter((r) => r.meeting_date || r.realized_date || r.status === 'reunion_agendada' || r.status === 'reunion_realizada');
  const totalMeetings = meetings.length;
  // Programadas: tienen fecha programada. Realizadas: tienen fecha realizada (o el estado lo dice
  // aunque el archivo original no haya traído fecha exacta, ej. "Marcar todo como realizada").
  const scheduled = records.filter((r) => r.meeting_date);
  const realized = records.filter((r) => r.realized_date || r.status === 'reunion_realizada');
  const conversionRate = totalContacted ? Math.round((totalMeetings / totalContacted) * 100) : 0;

  const byIndustry = {};
  const byCountry = {}; // key: país normalizado (sin mayúsculas/tildes) -> { label, count }
  const byCity = {}; // misma idea que byCountry, para no duplicar "Bogotá" / "bogota" / "BOGOTA"
  const byMonthScheduled = {};
  const byMonthRealized = {};
  const byPerson = {};

  // Siembra la tabla con TODO el equipo activo, aunque todavía no tengan registros —
  // así "Rendimiento por persona" siempre muestra a todos, no solo a quien ya tiene datos.
  teamMembers.forEach((m) => {
    byPerson[m.full_name] = { contacted: 0, meetings: 0, name: m.full_name };
  });

  records.forEach((r) => {
    const personKey = (r.executive && r.executive.trim()) || r.team_members?.full_name || 'Sin asignar';
    if (!byPerson[personKey]) byPerson[personKey] = { contacted: 0, meetings: 0, name: personKey };
    byPerson[personKey].contacted += 1;
  });

  meetings.forEach((r) => {
    const industry = r.industry || 'Sin especificar';
    byIndustry[industry] = (byIndustry[industry] || 0) + 1;

    const countryLabel = r.country?.trim() || 'Sin especificar';
    const countryKey = r.country ? normalizeCountry(r.country) : 'sin especificar';
    if (!byCountry[countryKey]) byCountry[countryKey] = { label: countryLabel, count: 0 };
    // Prefiere como etiqueta la versión que empiece con mayúscula, si aparece.
    if (countryLabel[0] === countryLabel[0]?.toUpperCase() && byCountry[countryKey].label[0] !== byCountry[countryKey].label[0]?.toUpperCase()) {
      byCountry[countryKey].label = countryLabel;
    }
    byCountry[countryKey].count += 1;

    const cityLabel = r.city?.trim() || 'Sin especificar';
    const cityKey = r.city ? normalizeCountry(r.city) : 'sin especificar';
    if (!byCity[cityKey]) byCity[cityKey] = { label: cityLabel, count: 0 };
    if (cityLabel[0] === cityLabel[0]?.toUpperCase() && byCity[cityKey].label[0] !== byCity[cityKey].label[0]?.toUpperCase()) {
      byCity[cityKey].label = cityLabel;
    }
    byCity[cityKey].count += 1;

    const personKey = (r.executive && r.executive.trim()) || r.team_members?.full_name || 'Sin asignar';
    if (byPerson[personKey]) byPerson[personKey].meetings += 1;
  });

  scheduled.forEach((r) => {
    const month = r.meeting_date.slice(0, 7);
    byMonthScheduled[month] = (byMonthScheduled[month] || 0) + 1;
  });
  realized.forEach((r) => {
    if (!r.realized_date) return; // sin fecha exacta (ej. marcado en lote sin fecha) no entra al desglose mensual
    const month = r.realized_date.slice(0, 7);
    byMonthRealized[month] = (byMonthRealized[month] || 0) + 1;
  });

  const thisMonthKey = new Date().toISOString().slice(0, 7);
  // by_month se mantiene por compatibilidad — usa la fecha programada, como antes.
  const byMonth = byMonthScheduled;

  return {
    total_contacted: totalContacted,
    total_meetings: totalMeetings,
    total_scheduled: scheduled.length,
    total_realized: realized.length,
    conversion_rate: conversionRate,
    meetings_this_month: byMonth[thisMonthKey] || 0,
    by_industry: Object.entries(byIndustry).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    by_position: groupSimilarPositions(meetings),
    by_country: Object.values(byCountry).map(({ label, count }) => ({ name: label, count })).sort((a, b) => b.count - a.count),
    by_city: Object.values(byCity).map(({ label, count }) => ({ name: label, count })).sort((a, b) => b.count - a.count),
    by_month: Object.entries(byMonth).map(([month, count]) => ({ month, count })).sort((a, b) => a.month.localeCompare(b.month)),
    by_month_scheduled: Object.entries(byMonthScheduled).map(([month, count]) => ({ month, count })).sort((a, b) => a.month.localeCompare(b.month)),
    by_month_realized: Object.entries(byMonthRealized).map(([month, count]) => ({ month, count })).sort((a, b) => a.month.localeCompare(b.month)),
    by_person: Object.values(byPerson)
      .map((p) => ({ ...p, conversion: p.contacted ? Math.round((p.meetings / p.contacted) * 100) : 0 }))
      .sort((a, b) => b.meetings - a.meetings),
  };
}

module.exports = { computeB2bDashboard };
