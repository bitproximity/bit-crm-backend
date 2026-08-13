const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { requirePage } = require('../middleware/pagePermissions');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);
router.use(requirePage('__admin_only__'));

function missingKeyError(provider) {
  const envVar = provider === 'lusha' ? 'LUSHA_API_KEY' : 'APOLLO_API_KEY';
  return { status: 400, message: `Falta configurar ${envVar} en las variables de entorno de Railway.` };
}

// ── LUSHA ──────────────────────────────────────────────

async function lushaEnrichContact(contact) {
  const body = {
    contacts: [{
      firstName: contact.first_name || undefined,
      lastName: contact.last_name || undefined,
      email: contact.email || undefined,
      companyName: contact.companies?.name || undefined,
    }],
    reveal: ['emails', 'phones'],
  };

  const res = await fetch('https://api.lusha.com/v3/contacts/search-and-enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', api_key: process.env.LUSHA_API_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw { status: res.status, message: data.message || 'Error de Lusha', raw: data };

  const result = data.results?.[0];
  if (!result || result.error) {
    throw { status: 404, message: result?.error?.message || 'Lusha no encontró coincidencias para este contacto.' };
  }

  return {
    raw: result,
    patch: {
      email: contact.email || result.emails?.[0]?.email || null,
      phone: contact.phone || result.phones?.[0]?.number || null,
      linkedin_url: contact.linkedin_url || result.socialLinks?.linkedin || null,
      position: contact.position || result.jobTitle?.title || null,
    },
  };
}

async function lushaEnrichCompany(company) {
  const body = { companies: [{ name: company.name || undefined }] };

  const res = await fetch('https://api.lusha.com/v3/companies/search-and-enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', api_key: process.env.LUSHA_API_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw { status: res.status, message: data.message || 'Error de Lusha', raw: data };

  const result = data.results?.[0];
  if (!result || result.error) {
    throw { status: 404, message: result?.error?.message || 'Lusha no encontró coincidencias para esta empresa.' };
  }

  return {
    raw: result,
    patch: {
      industry: company.industry || result.industry || null,
      country: company.country || result.location?.country || null,
      linkedin_url: company.linkedin_url || result.socialLinks?.linkedin || null,
      phone: company.phone || result.phone || null,
      employee_count: company.employee_count || (result.employeeCount ? `${result.employeeCount.min ?? ''}-${result.employeeCount.max ?? ''}` : null),
      description: company.description || result.description || result.companyOffering || null,
    },
  };
}

// ── APOLLO ─────────────────────────────────────────────

async function apolloEnrichContact(contact) {
  const params = new URLSearchParams({ reveal_personal_emails: 'false' });
  if (contact.first_name) params.set('first_name', contact.first_name);
  if (contact.last_name) params.set('last_name', contact.last_name);
  if (contact.email) params.set('email', contact.email);
  if (contact.companies?.name) params.set('organization_name', contact.companies.name);

  const res = await fetch(`https://api.apollo.io/api/v1/people/match?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': process.env.APOLLO_API_KEY },
  });
  const data = await res.json();
  if (!res.ok) throw { status: res.status, message: data.message || data.error || 'Error de Apollo', raw: data };

  const person = data.person;
  if (!person) throw { status: 404, message: 'Apollo no encontró coincidencias para este contacto.' };

  return {
    raw: person,
    patch: {
      email: contact.email || person.email || null,
      linkedin_url: contact.linkedin_url || person.linkedin_url || null,
      position: contact.position || person.title || null,
      country: contact.country || person.country || null,
    },
  };
}

async function apolloEnrichCompany(company) {
  const params = new URLSearchParams();
  if (company.name) params.set('name', company.name);

  const res = await fetch(`https://api.apollo.io/api/v1/organizations/enrich?${params.toString()}`, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': process.env.APOLLO_API_KEY },
  });
  const data = await res.json();
  if (!res.ok) throw { status: res.status, message: data.message || data.error || 'Error de Apollo', raw: data };

  const org = data.organization;
  if (!org) throw { status: 404, message: 'Apollo no encontró coincidencias para esta empresa.' };

  return {
    raw: org,
    patch: {
      industry: company.industry || org.industry || null,
      country: company.country || org.country || null,
      linkedin_url: company.linkedin_url || org.linkedin_url || null,
      phone: company.phone || org.phone || null,
      employee_count: company.employee_count || (org.estimated_num_employees ? String(org.estimated_num_employees) : null),
      description: company.description || org.short_description || null,
    },
  };
}

const PROVIDERS = {
  lusha: { contact: lushaEnrichContact, company: lushaEnrichCompany },
  apollo: { contact: apolloEnrichContact, company: apolloEnrichCompany },
};

// POST /api/enrichment/contacts/:id/:provider  (provider = lusha | apollo)
router.post('/contacts/:id/:provider', async (req, res) => {
  const { id, provider } = req.params;
  if (!PROVIDERS[provider]) return res.status(400).json({ error: `Proveedor desconocido: ${provider}` });

  const envKey = provider === 'lusha' ? process.env.LUSHA_API_KEY : process.env.APOLLO_API_KEY;
  if (!envKey) { const e = missingKeyError(provider); return res.status(e.status).json({ error: e.message }); }

  const { data: contact, error: fetchError } = await supabase
    .from('contacts').select('*, companies(name)').eq('id', id).maybeSingle();
  if (fetchError || !contact) return res.status(404).json({ error: 'Contacto no encontrado.' });

  try {
    const { raw, patch } = await PROVIDERS[provider].contact(contact);
    const { data: updated, error: updateError } = await supabase
      .from('contacts')
      .update({ ...patch, enriched_at: new Date().toISOString(), enrichment_source: provider })
      .eq('id', id)
      .select()
      .single();
    if (updateError) return res.status(400).json({ error: updateError.message });

    await logAudit('contact', id, 'updated', req.teamMember.id, { enrichment: provider });
    res.json({ contact: updated, provider, raw });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Error al enriquecer el contacto.', raw: err.raw });
  }
});

// POST /api/enrichment/companies/:id/:provider  (provider = lusha | apollo)
router.post('/companies/:id/:provider', async (req, res) => {
  const { id, provider } = req.params;
  if (!PROVIDERS[provider]) return res.status(400).json({ error: `Proveedor desconocido: ${provider}` });

  const envKey = provider === 'lusha' ? process.env.LUSHA_API_KEY : process.env.APOLLO_API_KEY;
  if (!envKey) { const e = missingKeyError(provider); return res.status(e.status).json({ error: e.message }); }

  const { data: company, error: fetchError } = await supabase
    .from('companies').select('*').eq('id', id).maybeSingle();
  if (fetchError || !company) return res.status(404).json({ error: 'Empresa no encontrada.' });

  try {
    const { raw, patch } = await PROVIDERS[provider].company(company);
    const { data: updated, error: updateError } = await supabase
      .from('companies')
      .update({ ...patch, enriched_at: new Date().toISOString(), enrichment_source: provider })
      .eq('id', id)
      .select()
      .single();
    if (updateError) return res.status(400).json({ error: updateError.message });

    await logAudit('company', id, 'updated', req.teamMember.id, { enrichment: provider });
    res.json({ company: updated, provider, raw });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Error al enriquecer la empresa.', raw: err.raw });
  }
});

module.exports = router;
