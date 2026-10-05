const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requirePage } = require('../middleware/pagePermissions');
const { logAudit } = require('../utils/audit');
const { normalizeContactName, normalizeEmail } = require('../utils/duplicates');
const { mergeCompanies, findDuplicateCompanyGroups } = require('../utils/mergeRecords');

const router = express.Router();
router.use(requireAuth);
router.use(requirePage('empresas'));

// GET /api/duplicates/companies — agrupa empresas cuyo nombre normalizado coincide
// (sin tildes/mayúsculas/sufijos legales como SAS, LLC, S.A.) — ej. "Bit Colombia SAS"
// y "BIT COLOMBIA S.A.S." caen en el mismo grupo.
router.get('/companies', async (req, res) => {
  try {
    const { groups } = await findDuplicateCompanyGroups();
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/duplicates/contacts — agrupa por email exacto (la señal más confiable) y,
// aparte, por nombre completo normalizado + misma empresa (para contactos sin email).
router.get('/contacts', async (req, res) => {
  // Paginado de a 1000 (límite de PostgREST): antes solo se revisaban los primeros 1000
  // contactos y los duplicados del resto no aparecían nunca.
  const contacts = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('contacts')
      .select('id, first_name, last_name, email, phone, company_id, created_at, companies(name), deals(count)')
      .order('created_at')
      .order('id')
      .range(from, from + 999);
    if (error) return res.status(500).json({ error: error.message });
    contacts.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  const byEmail = {};
  const byNameCompany = {};
  (contacts || []).forEach((c) => {
    const row = {
      id: c.id,
      name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
      email: c.email,
      phone: c.phone,
      company_name: c.companies?.name || null,
      created_at: c.created_at,
      deals_count: c.deals?.[0]?.count || 0,
    };
    const email = normalizeEmail(c.email);
    if (email) (byEmail[email] ||= []).push(row);
    else {
      const nameKey = normalizeContactName(c.first_name, c.last_name);
      if (nameKey) {
        const key = `${nameKey}|${c.company_id || 'none'}`;
        (byNameCompany[key] ||= []).push(row);
      }
    }
  });

  const duplicateGroups = [
    ...Object.values(byEmail).filter((g) => g.length > 1),
    ...Object.values(byNameCompany).filter((g) => g.length > 1),
  ];
  res.json(duplicateGroups);
});

// POST /api/duplicates/merge  { type: 'company'|'contact', primary_id, duplicate_ids: [...] }
// Reasigna todo lo que apunta a los duplicados hacia el registro principal, y los borra.
// Solo admin — es destructivo e irreversible.
router.post('/merge', requireRole('admin'), async (req, res) => {
  const { type, primary_id, duplicate_ids } = req.body;
  if (!['company', 'contact'].includes(type)) return res.status(400).json({ error: 'type debe ser company o contact' });
  if (!primary_id || !Array.isArray(duplicate_ids) || duplicate_ids.length === 0) {
    return res.status(400).json({ error: 'Faltan primary_id o duplicate_ids' });
  }
  if (duplicate_ids.includes(primary_id)) return res.status(400).json({ error: 'primary_id no puede estar también en duplicate_ids' });

  try {
    if (type === 'company') {
      await mergeCompanies(primary_id, duplicate_ids);
    } else {
      await supabase.from('deals').update({ contact_id: primary_id }).in('contact_id', duplicate_ids);
      await supabase.from('invoices').update({ contact_id: primary_id }).in('contact_id', duplicate_ids);
      await supabase.from('activities').update({ entity_id: primary_id }).eq('entity_type', 'contact').in('entity_id', duplicate_ids);
      // deal_contacts tiene unique(deal_id, contact_id) — si el mismo trato ya tenía
      // vinculados tanto al principal como a un duplicado, no se puede reasignar sin
      // chocar la restricción; en ese caso se borra la fila del duplicado en vez de moverla.
      const { data: rows } = await supabase.from('deal_contacts').select('id, deal_id').in('contact_id', duplicate_ids);
      for (const row of rows || []) {
        const { error: updErr } = await supabase.from('deal_contacts').update({ contact_id: primary_id }).eq('id', row.id);
        if (updErr) await supabase.from('deal_contacts').delete().eq('id', row.id);
      }
      const { error: delErr } = await supabase.from('contacts').delete().in('id', duplicate_ids);
      if (delErr) throw delErr;
    }
    await logAudit(type, primary_id, 'merged_duplicates', req.teamMember.id, { duplicate_ids });
    res.json({ ok: true, merged: duplicate_ids.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
