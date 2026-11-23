// Nombres excluidos del equipo de Bit Prospect (dashboard, leaderboard, metas) — tienen
// cuenta en el CRM pero no son parte del equipo que hace prospección/agenda de reuniones.
// Un solo lugar para esta lista — antes b2b.js tenía la suya propia y quotas.js no
// filtraba nada, así que alguien excluido acá igual aparecía en el panel de metas.
const { normName } = require('./quotaProgress');

const BIT_PROSPECT_TEAM_EXCLUDE = ['Diego Molina', 'Jorge', 'Jorge Iván', 'Mario Ramos', 'Martina Villacreses'];

// Compara sin importar mayúsculas, tildes ni espacios de más (así «mario  ramos» también queda fuera).
const EXCLUDED_NORMALIZED = new Set(BIT_PROSPECT_TEAM_EXCLUDE.map(normName));
const isExcludedFromBitProspect = (fullName) => EXCLUDED_NORMALIZED.has(normName(fullName));
// Para el campo libre «Ejecutivo» de cada reunión, donde a veces solo se escribe el nombre
// («Martina»): también cuenta como excluido si coincide con el primer nombre de alguien excluido.
const EXCLUDED_FIRST = new Set(BIT_PROSPECT_TEAM_EXCLUDE.map((n) => normName(n).split(' ')[0]));
const isExcludedExecutive = (name) => { const n = normName(name || ''); return !!n && (EXCLUDED_NORMALIZED.has(n) || EXCLUDED_FIRST.has(n)); };

module.exports = { BIT_PROSPECT_TEAM_EXCLUDE, isExcludedFromBitProspect, isExcludedExecutive };
