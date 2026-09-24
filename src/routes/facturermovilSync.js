const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// Facturero Móvil (Ecuador) — a diferencia de Stripe/Alegra, cada emisor (Mario Ramos,
// Hector Mario Ramos, Diana Sanchez, etc.) parece requerir su propia cuenta/token — así que
// se soportan hasta 4 cuentas, cada una con su nombre. Doc: https://app.factureromovil.com/api/doc
//   FACTUREROMOVIL_TOKEN_1 / FACTUREROMOVIL_NAME_1  (y _2, _3, _4)
function facturermovilAccountsFromEnv() {
  const accounts = [];
  for (let i = 1; i <= 4; i++) {
    const token = process.env[`FACTUREROMOVIL_TOKEN_${i}`];
    const name = process.env[`FACTUREROMOVIL_NAME_${i}`];
    if (token && name) accounts.push({ token, name });
  }
  return accounts;
}

// GET /api/invoice-sync/facturero-movil/preview — trae 2 documentos crudos de cada cuenta
// configurada, SIN guardar nada, para confirmar los nombres de campo reales antes de mapear
// la sincronización de verdad (la doc pública no trae ejemplos de respuesta).
router.get('/facturero-movil/preview', requireRole('admin'), async (req, res) => {
  const accounts = facturermovilAccountsFromEnv();
  if (accounts.length === 0) return res.status(400).json({ error: 'Falta configurar FACTUREROMOVIL_TOKEN_1 / FACTUREROMOVIL_NAME_1 (y opcionalmente _2, _3, _4) en Railway.' });

  const preview = [];
  for (const account of accounts) {
    try {
      const r = await fetch('https://app.factureromovil.com/api/documentos', {
        headers: { Authorization: account.token },
      });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text.slice(0, 500); }
      preview.push({
        account: account.name,
        status: r.status,
        sample: Array.isArray(data) ? data.slice(0, 2) : data,
        count: Array.isArray(data) ? data.length : null,
      });
    } catch (err) {
      preview.push({ account: account.name, error: err.message });
    }
  }
  res.json(preview);
});

module.exports = router;
