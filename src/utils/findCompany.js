// Busca una empresa existente por nombre ANTES de crear otra. Primero exacto (sin mayúsculas);
// si no, por nombre normalizado: sin tildes, sin «Grupo», sin S.A./SAS/Ltda. Así «MetroBank» encuentra
// a «MetroBank, S.A.», «BIMBO» a «Grupo Bimbo» y «Acropolis Business Mall» a «Acrópolis Business Mall».
// Lo usan Bit Prospect, los formularios públicos y el conector — los tres creaban duplicados porque
// solo comparaban el nombre exacto.
const supabase = require('../config/supabase');
const { normalizeCompanyName } = require('./duplicates');
const { escapeIlikeValue } = require('./escape');

async function findCompanyIdByName(rawName) {
  const name = String(rawName || '').trim().replace(/\s+/g, ' ');
  if (!name) return null;

  const { data: exact } = await supabase.from('companies').select('id').ilike('name', escapeIlikeValue(name)).order('created_at').limit(1);
  if (exact?.[0]) return exact[0].id;

  const norm = normalizeCompanyName(name);
  if (norm.length < 3) return null;
  const key = norm.split(' ').sort((a, b) => b.length - a.length)[0];
  if (!key || key.length < 3) return null;
  // Las vocales y la n se buscan con comodín de un carácter para que «acropolis» encuentre «Acrópolis»
  const pattern = `%${escapeIlikeValue(key).replace(/[aeioun]/g, '_')}%`;
  const { data: candidates } = await supabase.from('companies').select('id, name, created_at').ilike('name', pattern).order('created_at').limit(300);
  const hit = (candidates || []).find((c) => normalizeCompanyName(c.name) === norm);
  return hit ? hit.id : null;
}

module.exports = { findCompanyIdByName };
