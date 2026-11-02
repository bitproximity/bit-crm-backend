// Aviso de posibles duplicados ANTES de crear una empresa o un contacto (abierto a todo el
// equipo con sesión: también a outbound, que es quien más crea). Solo lectura.
//   GET /api/dup-check/company?name=Centro Comercial Oviedo
//   GET /api/dup-check/contact?email=ana@x.com&first_name=Ana&last_name=Pérez&company_id=…
const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { normalizeCompanyName, cleanName } = require('../utils/mergeRecords');
const { escapeIlikeValue } = require('../utils/escape');

const router = express.Router();
router.use(requireAuth);

// Prefijos genéricos que no identifican a la empresa ("CC Oviedo" = "Centro Comercial Oviedo")
const GENERIC = new Set(['cc', 'centro', 'comercial', 'hotel', 'hoteles', 'restaurante', 'grupo', 'mall', 'plaza', 'the', 'la', 'el', 'los', 'las', 'de', 'del']);
const coreWords = (norm) => norm.split(' ').filter((w) => w.length >= 3 && !GENERIC.has(w));

router.get('/company', async (req, res) => {
  const name = cleanName(String(req.query.name || ''));
  const norm = normalizeCompanyName(name);
  if (norm.length < 3) return res.json({ matches: [] });
  const words = coreWords(norm);
  const key = (words.sort((a, b) => b.length - a.length)[0]) || norm.split(' ')[0];

  const { data, error } = await supabase
    .from('companies')
    .select('id, name, country')
    .ilike('name', `%${escapeIlikeValue(key)}%`)
    .order('name')
    .limit(60);
  if (error) return res.status(500).json({ error: error.message });

  const wanted = new Set(coreWords(norm));
  const matches = (data || [])
    .map((c) => {
      const n = normalizeCompanyName(c.name);
      const cw = coreWords(n);
      let score = 0;
      if (n === norm) score = 3;                                            // mismo nombre normalizado
      else if (cw.length && cw.every((w) => wanted.has(w)) && [...wanted].every((w) => cw.includes(w))) score = 2; // mismas palabras clave
      else if ((n.includes(norm) || norm.includes(n)) && Math.min(n.length, norm.length) >= 4) score = 1; // uno contiene al otro
      return { ...c, exact: score === 3, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map(({ score, ...c }) => c);
  res.json({ matches });
});

router.get('/contact', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  const first = cleanName(String(req.query.first_name || ''));
  const last = cleanName(String(req.query.last_name || ''));
  const companyId = req.query.company_id || null;
  const found = new Map();

  if (email && email.includes('@')) {
    const { data } = await supabase.from('contacts')
      .select('id, first_name, last_name, email, companies(name)')
      .ilike('email', escapeIlikeValue(email)).limit(5);
    (data || []).forEach((c) => found.set(c.id, { ...c, reason: 'mismo email' }));
  }
  if (first && last) {
    let q = supabase.from('contacts')
      .select('id, first_name, last_name, email, companies(name)')
      .ilike('first_name', escapeIlikeValue(first))
      .ilike('last_name', escapeIlikeValue(last))
      .limit(5);
    if (companyId) q = q.eq('company_id', companyId);
    const { data } = await q;
    (data || []).forEach((c) => { if (!found.has(c.id)) found.set(c.id, { ...c, reason: companyId ? 'mismo nombre en la misma empresa' : 'mismo nombre' }); });
  }
  res.json({ matches: [...found.values()].slice(0, 5) });
});

module.exports = router;
