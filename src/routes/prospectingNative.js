// Búsqueda directa en Apollo / Lusha e importación a Bit CRM para la página "Prospección"
// del CRM. La página mandaba { provider, title, department, country } a /api/prospecting/search,
// pero esa ruta era solo el proxy de IA de la app externa (espera { prompt }) — por eso salía
// "Falta el campo prompt en el body". Este módulo atiende el formato del CRM; el proxy queda
// intacto para la app externa.

const fetch = require('node-fetch');
const supabase = require('../config/supabase');
const { loadCompanyMap, normalizeCompanyName, cleanName } = require('../utils/mergeRecords');
const { logAudit } = require('../utils/audit');

const PAGE_SIZE = 25;
const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

class UserError extends Error {}

async function apolloSearch({ title, country }) {
  const key = process.env.APOLLO_API_KEY;
  if (!key) throw new UserError('Apollo no está configurado: falta la variable APOLLO_API_KEY en Railway (Settings → Variables).');
  const titles = splitList(title);
  if (!titles.length) throw new UserError('Escribe al menos un cargo.');
  const body = { person_titles: titles, per_page: PAGE_SIZE, page: 1 };
  if (country) body.person_locations = [country];

  const res = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': key },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new UserError(`Apollo respondió ${res.status}: ${json.error || json.message || 'error desconocido'}`);

  return (json.people || []).map((p) => ({
    key: `apollo:${p.id}`,
    source: 'apollo',
    externalId: p.id,
    firstName: p.first_name || '',
    lastName: p.last_name || p.last_name_obfuscated || '',
    title: p.title || '',
    companyName: p.organization?.name || p.organization_name || '',
    country: p.country || country || '',
    linkedinUrl: p.linkedin_url || null,
  }));
}

async function lushaSearch({ department, country }) {
  const key = process.env.LUSHA_API_KEY;
  if (!key) throw new UserError('Lusha no está configurado: falta la variable LUSHA_API_KEY en Railway (Settings → Variables).');
  const departments = splitList(department);
  if (!departments.length) throw new UserError('Escribe al menos un departamento.');
  const include = { departments };
  if (country) include.locations = [{ country }];

  const res = await fetch('https://api.lusha.com/prospecting/contact/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', api_key: key },
    body: JSON.stringify({ pages: { page: 0, size: PAGE_SIZE }, filters: { contacts: { include } } }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new UserError(`Lusha respondió ${res.status}: ${json.message || json.error || 'error desconocido'}`);

  return (json.data || []).map((c) => {
    const full = typeof c.name === 'string' ? c.name : [c.name?.first, c.name?.last].filter(Boolean).join(' ');
    const [first, ...rest] = String(c.firstName || full || '').split(' ');
    return {
      key: `lusha:${c.contactId || c.id}`,
      source: 'lusha',
      externalId: c.contactId || c.id,
      firstName: c.firstName || first || '',
      lastName: c.lastName || rest.join(' '),
      title: c.jobTitle || c.title || '',
      companyName: c.companyName || c.company?.name || '',
      country: c.location?.country || c.country || country || '',
      linkedinUrl: c.socialLinks?.linkedin || null,
    };
  });
}

async function search(req, res) {
  try {
    const { provider, title, department, country } = req.body || {};
    const candidates = provider === 'lusha'
      ? await lushaSearch({ department, country })
      : await apolloSearch({ title, country });
    res.json({ candidates });
  } catch (err) {
    res.status(err instanceof UserError ? 400 : 500).json({ error: err.message });
  }
}

async function importCandidates(req, res) {
  try {
    const candidates = Array.isArray(req.body?.candidates) ? req.body.candidates : [];
    const listName = cleanName(req.body?.listName || '') || 'Prospección';
    if (!candidates.length) return res.status(400).json({ error: 'No hay contactos seleccionados.' });

    // Lista = etiqueta de contactos (así aparece en "Listas")
    let { data: tag } = await supabase.from('tags').select('id').ilike('name', listName).limit(1).maybeSingle();
    if (!tag) {
      const { data: created, error } = await supabase.from('tags').insert({ name: listName, color: '#8b5cf6' }).select('id').single();
      if (error) return res.status(500).json({ error: error.message });
      tag = created;
    }

    const companyMap = await loadCompanyMap();
    let imported = 0;
    let skipped = 0;

    for (const c of candidates) {
      const firstName = cleanName(c.firstName || '');
      if (!firstName) { skipped++; continue; }
      const lastName = cleanName(c.lastName || '');

      let companyId = null;
      const companyName = cleanName(c.companyName || '');
      const norm = normalizeCompanyName(companyName);
      if (norm) {
        companyId = companyMap.get(norm) || null;
        if (!companyId) {
          const { data: co, error } = await supabase.from('companies')
            .insert({ name: companyName, country: c.country || null, owner_id: req.teamMember.id })
            .select('id').single();
          if (error) return res.status(500).json({ error: error.message });
          companyId = co.id;
          companyMap.set(norm, companyId);
          await logAudit('company', companyId, 'created', req.teamMember.id, { via: 'prospeccion' });
        }
      }

      // Evita duplicar: misma persona (nombre + apellido) en la misma empresa
      let dup = supabase.from('contacts').select('id').ilike('first_name', firstName).limit(1);
      dup = lastName ? dup.ilike('last_name', lastName) : dup;
      dup = companyId ? dup.eq('company_id', companyId) : dup.is('company_id', null);
      const { data: existing } = await dup;
      if (existing && existing.length) {
        await supabase.from('taggables').upsert(
          { tag_id: tag.id, entity_type: 'contact', entity_id: existing[0].id },
          { onConflict: 'tag_id,entity_type,entity_id', ignoreDuplicates: true }
        );
        skipped++;
        continue;
      }

      const { data: contact, error } = await supabase.from('contacts').insert({
        first_name: firstName,
        last_name: lastName || null,
        position: c.title || null,
        country: c.country || null,
        linkedin_url: c.linkedinUrl || null,
        company_id: companyId,
        owner_id: req.teamMember.id,
        enrichment_source: c.source || null,
      }).select('id').single();
      if (error) return res.status(500).json({ error: error.message });

      await supabase.from('taggables').insert({ tag_id: tag.id, entity_type: 'contact', entity_id: contact.id });
      await logAudit('contact', contact.id, 'created', req.teamMember.id, { via: 'prospeccion', source: c.source });
      imported++;
    }

    res.json({ imported, skipped, list_name: listName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { search, importCandidates };
