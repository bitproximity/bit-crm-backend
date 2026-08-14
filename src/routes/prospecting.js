const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { requirePage } = require('../middleware/pagePermissions');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);
router.use(requirePage('__admin_only__'));

// POST /api/prospecting/search
// body: { provider: 'lusha' | 'apollo', title, department, country, page }
// Devuelve una VISTA PREVIA (nombre, cargo, empresa, país) — sin email/teléfono.
// Lusha cobra créditos por cada resultado de búsqueda aunque sea preview; Apollo no.
router.post('/search', async (req, res) => {
  const { provider, title, department, country, page = 0 } = req.body;

  if (provider === 'apollo') {
    if (!process.env.APOLLO_API_KEY) return res.status(400).json({ error: 'Falta configurar APOLLO_API_KEY en Railway.' });

    const params = new URLSearchParams({ page: String(page + 1), per_page: '25' });
    (title || '').split(',').map((t) => t.trim()).filter(Boolean).forEach((t) => params.append('person_titles[]', t));
    if (country) params.append('person_locations[]', country);

    const apiRes = await fetch(`https://api.apollo.io/api/v1/mixed_people/api_search?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': process.env.APOLLO_API_KEY },
    });
    const data = await apiRes.json();
    if (!apiRes.ok) {
      const hint = apiRes.status === 403
        ? ' Este endpoint de Apollo requiere una Master API key (Settings → API → generar con permisos completos), no una key restringida.'
        : '';
      return res.status(apiRes.status).json({ error: (data.error || data.message || 'Error de Apollo') + hint });
    }

    const candidates = (data.people || []).map((p) => ({
      key: `apollo:${p.id}`,
      provider: 'apollo',
      providerId: p.id,
      firstName: p.first_name || '',
      lastName: p.last_name || '',
      title: p.title || '',
      companyName: p.organization?.name || '',
      companyDomain: p.organization?.primary_domain || p.organization?.website_url || '',
      country: p.country || '',
      linkedinUrl: p.linkedin_url || '',
    }));
    return res.json({ candidates, total: data.pagination?.total_entries ?? candidates.length });
  }

  if (provider === 'lusha') {
    if (!process.env.LUSHA_API_KEY) return res.status(400).json({ error: 'Falta configurar LUSHA_API_KEY en Railway.' });

    const include = {};
    if (department) include.departments = department.split(',').map((d) => d.trim()).filter(Boolean);
    if (country) include.locations = [{ country }];
    if (Object.keys(include).length === 0) {
      return res.status(400).json({ error: 'Para Lusha indica al menos departamento o país (el filtro de cargo libre no está soportado por esta vía).' });
    }

    const apiRes = await fetch('https://api.lusha.com/v3/contacts/prospecting', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', api_key: process.env.LUSHA_API_KEY },
      body: JSON.stringify({ pages: { page, size: 25 }, filters: { contacts: { include } } }),
    });
    const data = await apiRes.json();
    if (!apiRes.ok) return res.status(apiRes.status).json({ error: data.message || 'Error de Lusha' });

    const candidates = (data.results || []).map((r) => ({
      key: `lusha:${r.id}`,
      provider: 'lusha',
      providerId: r.id,
      firstName: r.firstName || '',
      lastName: r.lastName || '',
      title: r.jobTitle?.title || '',
      companyName: r.company?.name || '',
      companyDomain: r.company?.domain || '',
      country: r.location?.country || '',
      linkedinUrl: r.socialLinks?.linkedin || '',
    }));
    return res.json({ candidates, total: data.total ?? candidates.length });
  }

  res.status(400).json({ error: `Proveedor desconocido: ${provider}` });
});

// POST /api/prospecting/import  { candidates: [...], listName? }  (misma forma que devuelve /search)
// Crea Empresa (si no existe, por nombre) + Contacto para cada candidato seleccionado.
// Si se manda listName, además crea/reusa un tag con ese nombre y etiqueta a cada contacto importado —
// así queda armada la "lista" (ej. "Apollo", "Lusha", o cualquier nombre custom) para filtrar después.
// No revela email/telefono aquí — para eso usa los botones "Lusha"/"Apollo" ya existentes
// en el detalle del contacto recién creado (evita gastar créditos en gente que luego no sirve).
router.post('/import', async (req, res) => {
  const { candidates, listName } = req.body;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return res.status(400).json({ error: 'candidates debe ser un array no vacío.' });
  }

  let tagId = null;
  if (listName && listName.trim()) {
    const { data: existingTag } = await supabase.from('tags').select('id').ilike('name', listName.trim()).maybeSingle();
    if (existingTag) {
      tagId = existingTag.id;
    } else {
      const { data: newTag, error: tagError } = await supabase.from('tags').insert({ name: listName.trim() }).select('id').single();
      if (!tagError) tagId = newTag.id;
    }
  }

  const created = [];
  const skipped = [];

  for (const c of candidates) {
    let companyId = null;
    if (c.companyName) {
      const { data: existing } = await supabase.from('companies').select('id').ilike('name', c.companyName).maybeSingle();
      if (existing) {
        companyId = existing.id;
      } else {
        const { data: newCompany, error: companyError } = await supabase
          .from('companies')
          .insert({ name: c.companyName, country: c.country || null })
          .select('id')
          .single();
        if (companyError) { skipped.push({ candidate: c, reason: companyError.message }); continue; }
        companyId = newCompany.id;
      }
    }

    // Evita duplicar si ya existe un contacto con el mismo nombre en la misma empresa.
    if (companyId && c.firstName) {
      const { data: dupe } = await supabase
        .from('contacts').select('id').eq('company_id', companyId)
        .ilike('first_name', c.firstName).ilike('last_name', c.lastName || '').maybeSingle();
      if (dupe) { skipped.push({ candidate: c, reason: 'Ya existe un contacto con este nombre en esta empresa.' }); continue; }
    }

    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .insert({
        first_name: c.firstName || null,
        last_name: c.lastName || null,
        position: c.title || null,
        country: c.country || null,
        company_id: companyId,
        linkedin_url: c.linkedinUrl || null,
        owner_id: req.teamMember.id,
        source: c.provider === 'lusha' ? 'lusha_prospecting' : 'apollo_prospecting',
      })
      .select()
      .single();

    if (contactError) { skipped.push({ candidate: c, reason: contactError.message }); continue; }
    if (tagId) await supabase.from('taggables').insert({ tag_id: tagId, entity_type: 'contact', entity_id: contact.id });
    created.push(contact);
  }

  if (created.length) await logAudit('contact', created[0].id, 'created', req.teamMember.id, { bulk_import: created.length, source: 'prospecting' });

  res.json({ imported: created.length, skipped: skipped.length, contacts: created, skipped_details: skipped, list_name: listName?.trim() || null });
});

module.exports = router;
