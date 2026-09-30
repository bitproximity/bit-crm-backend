// Nombres excluidos del equipo de Bit Prospect (dashboard, leaderboard, metas) — tienen
// cuenta en el CRM pero no son parte del equipo que hace prospección/agenda de reuniones.
// Un solo lugar para esta lista — antes b2b.js tenía la suya propia y quotas.js no
// filtraba nada, así que alguien excluido acá igual aparecía en el panel de metas.
const BIT_PROSPECT_TEAM_EXCLUDE = ['Diego Molina', 'Jorge'];

module.exports = { BIT_PROSPECT_TEAM_EXCLUDE };
