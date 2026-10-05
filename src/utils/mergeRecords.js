const supabase = require('../config/supabase');
const { normalizeCompanyName } = require('./duplicates');

// Fusiona empresas duplicadas en una principal: mueve TODO lo que apunta a los duplicados
// (tratos, contactos, facturas, proyectos, documentos, actividades, archivos de Drive y
// registros de Bit Prospect) y recién después borra los duplicados.
// Antes solo movía tratos/contactos/facturas/actividades — los proyectos y documentos
// quedaban sin empresa, y los registros de Bit Prospect se BORRABAN en cascada.
async function mergeCompanies(primaryId, duplicateIds) {
  const steps = [
    supabase.from('deals').update({ company_id: primaryId }).in('company_id', duplicateIds),
    supabase.from('contacts').update({ company_id: primaryId }).in('company_id', duplicateIds),
    supabase.from('invoices').update({ company_id: primaryId }).in('company_id', duplicateIds),
    supabase.from('projects').update({ company_id: primaryId }).in('company_id', duplicateIds),
    supabase.from('documents').update({ company_id: primaryId }).in('company_id', duplicateIds),
    supabase.from('b2b_records').update({ client_company_id: primaryId }).in('client_company_id', duplicateIds),
    supabase.from('activities').update({ entity_id: primaryId }).eq('entity_type', 'company').in('entity_id', duplicateIds),
    supabase.from('drive_files').update({ entity_id: primaryId }).eq('entity_type', 'company').in('entity_id', duplicateIds),
  ];
  for (const step of steps) {
    const { error } = await step;
    if (error) throw new Error(error.message);
  }

  // Si algún duplicado era cliente de Bit Prospect, la principal hereda la marca
  const { data: dupFlags } = await supabase.from('companies').select('is_b2b_client').in('id', duplicateIds);
  if ((dupFlags || []).some((c) => c.is_b2b_client)) {
    await supabase.from('companies').update({ is_b2b_client: true }).eq('id', primaryId);
  }

  const { error: delErr } = await supabase.from('companies').delete().in('id', duplicateIds);
  if (delErr) throw new Error(delErr.message);
  return { merged: duplicateIds.length };
}

// Agrupa empresas por nombre normalizado (sin tildes/mayúsculas/espacios/sufijos legales).
// Pagina de a 1000 para no cortarse en el límite por defecto de PostgREST.
async function findDuplicateCompanyGroups() {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('companies')
      .select('id, name, industry, country, created_at, deals(count), contacts(count)')
      .order('created_at')
      .order('id') // desempate: miles de empresas importadas comparten created_at
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  const groups = {};
  all.forEach((c) => {
    const key = normalizeCompanyName(c.name);
    if (!key) return;
    (groups[key] ||= []).push({
      id: c.id,
      name: c.name,
      industry: c.industry,
      country: c.country,
      created_at: c.created_at,
      deals_count: c.deals?.[0]?.count || 0,
      contacts_count: c.contacts?.[0]?.count || 0,
    });
  });
  return { total_companies: all.length, groups: Object.values(groups).filter((g) => g.length > 1) };
}

// Nombre limpio: sin espacios al inicio/final ni dobles — los espacios sobrantes son lo
// que hacía que un import creara "Banistmo " aparte de "Banistmo".
function cleanName(name) {
  return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : name;
}

// Mapa nombreNormalizado -> id de TODAS las empresas, paginando de a 1000. Los imports
// antes traían companies sin paginar: pasadas las 1000 empresas, las que quedaban fuera
// del primer bloque "no existían" y el import las volvía a crear — fuente real de
// duplicados. También compara por nombre normalizado, no solo minúsculas.
async function loadCompanyMap() {
  const map = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('companies').select('id, name').order('created_at').order('id').range(from, from + 999);
    if (error) throw new Error(error.message);
    (data || []).forEach((c) => {
      const key = normalizeCompanyName(c.name);
      if (key && !map.has(key)) map.set(key, c.id);
    });
    if (!data || data.length < 1000) break;
  }
  return map;
}

module.exports = { mergeCompanies, findDuplicateCompanyGroups, cleanName, loadCompanyMap, normalizeCompanyName };
