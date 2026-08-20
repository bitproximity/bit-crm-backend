function normalizeCountry(c) {
  return (c || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function computeB2bDashboard(records, teamMembers = []) {
  const totalContacted = records.length;
  const meetings = records.filter((r) => r.meeting_date || r.status === 'reunion_agendada' || r.status === 'reunion_realizada');
  const totalMeetings = meetings.length;
  const conversionRate = totalContacted ? Math.round((totalMeetings / totalContacted) * 100) : 0;

  const byIndustry = {};
  const byCountry = {}; // key: país normalizado (sin mayúsculas/tildes) -> { label, count }
  const byMonth = {};
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

    if (r.meeting_date) {
      const month = r.meeting_date.slice(0, 7);
      byMonth[month] = (byMonth[month] || 0) + 1;
    }
    const personKey = (r.executive && r.executive.trim()) || r.team_members?.full_name || 'Sin asignar';
    if (byPerson[personKey]) byPerson[personKey].meetings += 1;
  });

  const thisMonthKey = new Date().toISOString().slice(0, 7);

  return {
    total_contacted: totalContacted,
    total_meetings: totalMeetings,
    conversion_rate: conversionRate,
    meetings_this_month: byMonth[thisMonthKey] || 0,
    by_industry: Object.entries(byIndustry).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    by_country: Object.values(byCountry).map(({ label, count }) => ({ name: label, count })).sort((a, b) => b.count - a.count),
    by_month: Object.entries(byMonth).map(([month, count]) => ({ month, count })).sort((a, b) => a.month.localeCompare(b.month)),
    by_person: Object.values(byPerson)
      .map((p) => ({ ...p, conversion: p.contacted ? Math.round((p.meetings / p.contacted) * 100) : 0 }))
      .sort((a, b) => b.meetings - a.meetings),
  };
}

module.exports = { computeB2bDashboard };
