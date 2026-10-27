// Búsqueda directa en Apollo / Lusha e importación a Bit CRM para la página "Prospección".
//
// v2 — motor del ecosistema de prospección:
//   · Filtros (industria, tamaño, empresa, palabras clave) y paginación.
//   · Cada resultado llega marcado con lo que YA existe en el CRM (empresa, trato abierto,
//     contacto) para no contactar dos veces a la misma gente.
//   · La importación puede (opcional, con confirmación explícita en la UI):
//       – revelar email/teléfono (consume créditos → solo admin, tope por importación),
//       – crear un trato en el embudo/etapa elegidos (si el rol puede ver "deals").
//   · Todo queda en el audit_log con via: 'prospeccion'.
// Apollo (mixed_people/api_search) devuelve nombres ofuscados y sin email, y exige un plan de pago de Apollo (el gratuito responde 403);
// Lusha (API V3) cobra créditos por cada resultado de la búsqueda.

const fetch = require('node-fetch');
const supabase = require('../config/supabase');
const { loadCompanyMap, normalizeCompanyName, cleanName } = require('../utils/mergeRecords');
const { logAudit } = require('../utils/audit');
const { selectIn } = require('../utils/fetchAll');
const { roleCanAccess } = require('../middleware/pagePermissions');
const enrichment = require('./enrichment');

const PAGE_SIZE = 25;
const REVEAL_CAP = 25;      // máximo de revelados (créditos) por importación
const IMPORT_CAP = 100;
const SIZE_RANGES = ['1,10', '11,50', '51,200', '201,500', '501,1000', '1001,5000', '5001,10000'];
const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const cleanRanges = (arr) => (Array.isArray(arr) ? arr : []).map(String).filter((r) => /^\d+,\d+$/.test(r)).slice(0, 8);
const normName = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

class UserError extends Error {}

// Mensajes claros cuando Lusha o Apollo rechazan una petición: qué pasó y qué hacer, no solo el código.
function lushaErrorMessage(status, json) {
  const detail = String(json?.message || json?.error || '').trim();
  const text = {
    401: 'La API key de Lusha es inválida o fue revocada. Genera una nueva en dashboard.lusha.com → API y actualiza LUSHA_API_KEY en Railway.',
    402: 'Tu cuenta de Lusha no tiene créditos suficientes para esta búsqueda.',
    403: 'Tu cuenta de Lusha no tiene acceso a esta API (cuenta inactiva o API V3 no habilitada). Escribe a support@lusha.com.',
    410: 'Lusha retiró la API antigua para tu cuenta y esta búsqueda aún usaba el endpoint viejo.',
    429: 'Lusha limitó las peticiones por minuto/hora/día. Espera un momento e intenta de nuevo.',
    451: 'Lusha bloqueó esta búsqueda por normativa de datos (GDPR).',
  }[status];
  return text ? `${text}${detail ? ` (${detail})` : ''}` : `Lusha respondió ${status}: ${detail || 'error desconocido'}`;
}

function apolloErrorMessage(status, json) {
  const detail = String(json?.error || json?.message || '').trim();
  if (status === 403 && /free plan|not included|upgrade/i.test(detail)) {
    return 'Apollo: tu plan gratuito no incluye la búsqueda de personas por API (ni con la master key). Usa Lusha, o sube tu plan de Apollo (apollo.io/pricing) para activarla.';
  }
  const text = {
    401: 'La API key de Apollo es inválida o fue revocada. Revisa APOLLO_API_KEY en Railway.',
    422: 'Apollo no aceptó los filtros de esta búsqueda. Prueba con menos filtros.',
    429: 'Apollo limitó las peticiones. Espera un momento e intenta de nuevo.',
  }[status];
  return text ? `${text}${detail ? ` (${detail})` : ''}` : `Apollo respondió ${status}: ${detail || 'error desconocido'}`;
}

// ── Búsqueda ──────────────────────────────────────────────────────────────
async function apolloSearch({ title, country, industry, company, keywords, sizes, page }) {
  const key = process.env.APOLLO_API_KEY;
  if (!key) throw new UserError('Apollo no está configurado: falta la variable APOLLO_API_KEY en Railway (Settings → Variables).');
  const titles = splitList(title);
  if (!titles.length) throw new UserError('Escribe al menos un cargo.');
  const body = { person_titles: titles, per_page: PAGE_SIZE, page };
  if (country) body.person_locations = [country];
  const kw = [industry, company, keywords].map((s) => String(s || '').trim()).filter(Boolean).join(' ');
  if (kw) body.q_keywords = kw;
  const ranges = cleanRanges(sizes);
  if (ranges.length) body.organization_num_employees_ranges = ranges;

  const res = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': key },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new UserError(apolloErrorMessage(res.status, json));

  const candidates = (json.people || []).map((p) => ({
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
  const pg = json.pagination || {};
  return {
    candidates,
    total: pg.total_entries ?? json.total_entries ?? null,
    hasMore: pg.total_pages != null ? page < pg.total_pages : candidates.length >= PAGE_SIZE,
  };
}

// Lusha API V3 (POST /v3/contacts/prospecting). La V2 (/prospecting/contact/search) dejó de estar disponible para la cuenta y respondía
// 410. Diferencias: paginación en `pagination` (página desde 0), clave en la cabecera `api_key`, y los contactos llegan en `results` con
// cargo, empresa y ubicación como objetos. Devuelve solo una vista previa (sin email/teléfono): eso se revela al importar.
async function lushaSearch({ department, country, company, sizes, page }) {
  const key = process.env.LUSHA_API_KEY;
  if (!key) throw new UserError('Lusha no está configurado: falta la variable LUSHA_API_KEY en Railway (Settings → Variables).');
  const departments = splitList(department);
  if (!departments.length) throw new UserError('Escribe al menos un departamento.');
  const include = { departments };
  if (country) include.locations = [{ country }];
  const filters = { contacts: { include } };
  const names = splitList(company);
  const lushaSizes = cleanRanges(sizes).map((r) => { const [min, max] = r.split(',').map(Number); return { min, max }; });
  if (names.length || lushaSizes.length) {
    filters.companies = { include: {} };
    if (names.length) filters.companies.include.names = names;
    if (lushaSizes.length) filters.companies.include.sizes = lushaSizes;
  }

  const res = await fetch('https://api.lusha.com/v3/contacts/prospecting', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', api_key: key },
    body: JSON.stringify({ pagination: { page: page - 1, size: PAGE_SIZE }, filters, options: { includePartialProfiles: true } }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new UserError(lushaErrorMessage(res.status, json));

  const rows = Array.isArray(json.results) ? json.results : [];
  const candidates = rows.filter((c) => c && c.id && !c.error).map((c) => ({
    key: `lusha:${c.id}`,
    source: 'lusha',
    externalId: String(c.id),
    firstName: c.firstName || '',
    lastName: c.lastName || '',
    title: (typeof c.jobTitle === 'string' ? c.jobTitle : c.jobTitle?.title) || '',
    companyName: c.company?.name || '',
    country: c.location?.country || country || '',
    linkedinUrl: c.socialLinks?.linkedin || null,
  }));
  const total = Number.isFinite(json.pagination?.total) ? json.pagination.total : null;
  return {
    candidates,
    total,
    hasMore: total != null ? page * PAGE_SIZE < total : rows.length >= PAGE_SIZE,
  };
}

// Marca cada candidato con lo que ya existe en el CRM. Si algo falla, la búsqueda sigue sin marcas.
async function annotateWithCrm(candidates, teamMember) {
  try {
    const companyMap = await loadCompanyMap();
    const companyOf = (c) => companyMap.get(normalizeCompanyName(c.companyName)) || null;
    const companyIds = [...new Set(candidates.map(companyOf).filter(Boolean))];
    if (!companyIds.length) return;

    const seeDeals = roleCanAccess(teamMember, 'deals');
    const [dealsRes, contactsRes] = await Promise.all([
      selectIn(() => supabase.from('deals').select('id, title, company_id, pipelines(name), pipeline_stages(name)').eq('status', 'abierto'), 'company_id', companyIds),
      selectIn(() => supabase.from('contacts').select('id, first_name, last_name, company_id, email'), 'company_id', companyIds),
    ]);
    const deals = dealsRes.data || [];
    const contacts = contactsRes.data || [];

    candidates.forEach((c) => {
      const companyId = companyOf(c);
      if (!companyId) return;
      const myDeals = deals.filter((d) => d.company_id === companyId);
      const first = normName(c.firstName);
      const lastRaw = normName(c.lastName);
      const lastPrefix = lastRaw.split('*')[0].trim();
      const obfuscated = lastRaw.includes('*');
      const match = contacts.find((k) => {
        if (k.company_id !== companyId || normName(k.first_name) !== first) return false;
        const kl = normName(k.last_name);
        if (!lastRaw) return true;
        return obfuscated ? (lastPrefix ? kl.startsWith(lastPrefix) : false) : kl === lastRaw;
      });
      c.crm = {
        companyId,
        openDeals: myDeals.length,
        ...(seeDeals ? { deals: myDeals.map((d) => ({ id: d.id, title: d.title, pipeline: d.pipelines?.name || null, stage: d.pipeline_stages?.name || null })) } : {}),
        contactId: match ? match.id : null,
        contactHasEmail: match ? !!match.email : false,
      };
    });
  } catch (err) {
    console.error('annotateWithCrm:', err.message);
  }
}

async function search(req, res) {
  try {
    const { provider, title, department, country, industry, company, keywords, sizes } = req.body || {};
    const page = Math.min(200, Math.max(1, parseInt(req.body?.page, 10) || 1));
    const out = provider === 'lusha'
      ? await lushaSearch({ department, country, company, sizes, page })
      : await apolloSearch({ title, country, industry, company, keywords, sizes, page });
    await annotateWithCrm(out.candidates, req.teamMember);
    res.json({ candidates: out.candidates, page, hasMore: out.hasMore, total: out.total, pageSize: PAGE_SIZE });
  } catch (err) {
    res.status(err instanceof UserError ? 400 : 500).json({ error: err.message });
  }
}

// ── Opciones para la UI (qué puede hacer quien pregunta) ───────────────────
function options(req, res) {
  const tm = req.teamMember;
  res.json({
    canReveal: roleCanAccess(tm, '__admin_only__'),
    canCreateDeals: roleCanAccess(tm, 'deals'),
    revealCap: REVEAL_CAP,
    importCap: IMPORT_CAP,
    pageSize: PAGE_SIZE,
    sizeRanges: SIZE_RANGES,
  });
}

// ── Revelar email/teléfono (consume créditos) ──────────────────────────────
async function apolloRevealById(externalId) {
  const key = process.env.APOLLO_API_KEY;
  if (!key) throw new UserError('Falta APOLLO_API_KEY en Railway.');
  const params = new URLSearchParams({ id: externalId, reveal_personal_emails: 'false' });
  const res = await fetch(`https://api.apollo.io/api/v1/people/match?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': key },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new UserError(apolloErrorMessage(res.status, data));
  const p = data.person;
  if (!p) throw new UserError('Apollo no encontró coincidencias.');
  const email = p.email && !/email_not_unlocked/i.test(p.email) ? p.email : null;
  return { first_name: p.first_name || null, last_name: p.last_name || null, email, linkedin_url: p.linkedin_url || null, position: p.title || null };
}

async function revealCandidate(c, ctx) {
  if (c.source === 'apollo' && c.externalId) return apolloRevealById(c.externalId);
  const provider = c.source === 'lusha' ? 'lusha' : 'apollo';
  const { patch } = await enrichment.PROVIDERS[provider].contact({
    first_name: ctx.firstName, last_name: ctx.lastName, email: null, companies: { name: ctx.companyName },
  });
  return patch;
}

// ── Importación ────────────────────────────────────────────────────────────
async function importCandidates(req, res) {
  try {
    const tm = req.teamMember;
    const candidates = (Array.isArray(req.body?.candidates) ? req.body.candidates : []).filter((c) => c && typeof c === 'object');
    const listName = cleanName(req.body?.listName || '') || 'Prospección';
    const revealEmails = !!req.body?.revealEmails;
    const dealOpts = req.body?.createDeal && typeof req.body.createDeal === 'object' ? req.body.createDeal : null;
    if (!candidates.length) return res.status(400).json({ error: 'No hay contactos seleccionados.' });
    if (candidates.length > IMPORT_CAP) return res.status(400).json({ error: `Máximo ${IMPORT_CAP} contactos por importación.` });
    if (revealEmails && !roleCanAccess(tm, '__admin_only__')) {
      return res.status(403).json({ error: 'Revelar email/teléfono consume créditos y solo está disponible para admins.' });
    }
    if (dealOpts && !roleCanAccess(tm, 'deals')) {
      return res.status(403).json({ error: 'Tu rol no puede crear tratos.' });
    }

    // Embudo y etapa destino (si se pidió crear tratos)
    let pipeline = null;
    let stage = null;
    if (dealOpts) {
      const { data: p } = await supabase.from('pipelines').select('id, name, pipeline_stages(id, name, position)').eq('id', dealOpts.pipelineId).maybeSingle();
      if (!p) return res.status(400).json({ error: 'Embudo no encontrado.' });
      const stages = (p.pipeline_stages || []).slice().sort((a, b) => a.position - b.position);
      stage = dealOpts.stageId ? stages.find((s) => s.id === dealOpts.stageId) : stages[0];
      if (!stage) return res.status(400).json({ error: 'Etapa no encontrada en ese embudo.' });
      pipeline = p;
    }

    // Lista = etiqueta de contactos (así aparece en "Listas")
    let { data: tag } = await supabase.from('tags').select('id').ilike('name', listName).limit(1).maybeSingle();
    if (!tag) {
      const { data: created, error } = await supabase.from('tags').insert({ name: listName, color: '#8b5cf6' }).select('id').single();
      if (error) return res.status(500).json({ error: error.message });
      tag = created;
    }

    const companyMap = await loadCompanyMap();

    // Empresas que ya tienen un trato abierto en el embudo destino (para no duplicar tratos)
    let companiesWithDeal = new Set();
    if (pipeline) {
      const knownIds = candidates.map((c) => companyMap.get(normalizeCompanyName(cleanName(c.companyName || '')))).filter(Boolean);
      const { data: open } = await selectIn(() => supabase.from('deals').select('id, company_id').eq('status', 'abierto').eq('pipeline_id', pipeline.id), 'company_id', knownIds);
      companiesWithDeal = new Set((open || []).map((d) => d.company_id));
    }

    const out = { imported: 0, skipped: 0, revealed: 0, dealsCreated: 0, dealsSkipped: 0, errors: 0 };
    const results = [];
    let revealsUsed = 0;

    for (const c of candidates) {
      const r = { key: c.key, status: 'skipped', contactId: null, companyId: null, email: null, revealed: false, dealId: null, dealStatus: null };
      try {
        const firstName = cleanName(c.firstName || '');
        if (!firstName) { out.skipped++; r.reason = 'sin nombre'; results.push(r); continue; }
        const lastName = cleanName(c.lastName || '');

        let companyId = null;
        const companyName = cleanName(c.companyName || '');
        const norm = normalizeCompanyName(companyName);
        if (norm) {
          companyId = companyMap.get(norm) || null;
          if (!companyId) {
            const { data: co, error } = await supabase.from('companies')
              .insert({ name: companyName, country: c.country || null, owner_id: tm.id })
              .select('id').single();
            if (error) throw new Error(error.message);
            companyId = co.id;
            companyMap.set(norm, companyId);
            await logAudit('company', companyId, 'created', tm.id, { via: 'prospeccion' });
          }
        }
        r.companyId = companyId;

        // Evita duplicar: misma persona (nombre + apellido) en la misma empresa.
        // Con apellido ofuscado (Apollo: "Fe***z") no se compara el apellido, solo nombre + empresa.
        const compareLast = lastName && !lastName.includes('*');
        let dup = supabase.from('contacts').select('id, email').ilike('first_name', firstName).limit(1);
        dup = compareLast ? dup.ilike('last_name', lastName) : dup;
        dup = companyId ? dup.eq('company_id', companyId) : dup.is('company_id', null);
        const { data: existing } = await dup;

        let contactId;
        let email = null;
        if (existing && existing.length) {
          contactId = existing[0].id;
          email = existing[0].email || null;
          await supabase.from('taggables').upsert(
            { tag_id: tag.id, entity_type: 'contact', entity_id: contactId },
            { onConflict: 'tag_id,entity_type,entity_id', ignoreDuplicates: true }
          );
          out.skipped++;
          r.status = 'existing';
        } else {
          const { data: contact, error } = await supabase.from('contacts').insert({
            first_name: firstName,
            last_name: lastName || null,
            position: c.title || null,
            country: c.country || null,
            linkedin_url: c.linkedinUrl || null,
            company_id: companyId,
            owner_id: tm.id,
            enrichment_source: c.source || null,
          }).select('id').single();
          if (error) throw new Error(error.message);
          contactId = contact.id;
          await supabase.from('taggables').insert({ tag_id: tag.id, entity_type: 'contact', entity_id: contactId });
          await logAudit('contact', contactId, 'created', tm.id, { via: 'prospeccion', source: c.source });
          out.imported++;
          r.status = 'imported';
        }
        r.contactId = contactId;

        // Revelar email/teléfono (créditos) — solo si se pidió, el contacto no lo tiene y no se pasó el tope
        if (revealEmails && !email && revealsUsed < REVEAL_CAP) {
          revealsUsed++;
          try {
            const patch = await revealCandidate(c, { firstName, lastName, companyName });
            if (patch) {
              const update = { enriched_at: new Date().toISOString(), enrichment_source: c.source || null };
              if (patch.email) update.email = patch.email;
              if (patch.phone) update.phone = patch.phone;
              if (patch.linkedin_url) update.linkedin_url = patch.linkedin_url;
              if (patch.position && !c.title) update.position = patch.position;
              if (patch.last_name && (!lastName || lastName.includes('*'))) update.last_name = patch.last_name;
              await supabase.from('contacts').update(update).eq('id', contactId);
              await logAudit('contact', contactId, 'updated', tm.id, { enrichment: c.source, via: 'prospeccion' });
              if (patch.email) { email = patch.email; r.revealed = true; out.revealed++; }
              if (update.last_name) r.lastName = update.last_name;
            }
          } catch (revealErr) {
            r.revealError = revealErr.message;
          }
        }
        r.email = email;

        // Crear trato en el embudo/etapa elegidos (uno por empresa)
        if (pipeline && companyId) {
          if (companiesWithDeal.has(companyId)) {
            r.dealStatus = 'exists'; out.dealsSkipped++;
          } else {
            const base = String(dealOpts.title || '').trim() || '{empresa} — Prospección';
            const title = base.replace(/\{empresa\}/gi, companyName || 'Prospecto').slice(0, 200);
            const { data: deal, error } = await supabase.from('deals').insert({
              title, value: 0, currency: 'USD', status: 'abierto',
              pipeline_id: pipeline.id, stage_id: stage.id,
              contact_id: contactId, company_id: companyId, owner_id: tm.id,
            }).select('id').single();
            if (error) throw new Error(`trato: ${error.message}`);
            await logAudit('deal', deal.id, 'created', tm.id, { via: 'prospeccion' });
            companiesWithDeal.add(companyId);
            r.dealId = deal.id; r.dealStatus = 'created'; out.dealsCreated++;
          }
        }
      } catch (err) {
        out.errors++;
        r.status = 'error';
        r.error = err.message;
      }
      results.push(r);
    }

    if (out.errors === candidates.length) return res.status(500).json({ error: results[0]?.error || 'No se pudo importar.', results });
    res.json({ ...out, list_name: listName, tag_id: tag.id, pipeline: pipeline ? pipeline.name : null, stage: stage ? stage.name : null, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { search, options, importCandidates, lushaSearch, apolloSearch, lushaErrorMessage, apolloErrorMessage };
