const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// Facturero Móvil (Ecuador) — a diferencia de Stripe/Alegra, se autentica con
// usuario/clave (no un token fijo): POST /api/login_check devuelve un JWT que hay que usar
// en las llamadas siguientes. Cada emisor (Mario Ramos, Hector Mario Ramos, Diana Sanchez,
// etc.) parece tener su propio usuario — se soportan hasta 4 cuentas.
// Doc: https://app.factureromovil.com/api/doc
//   FACTUREROMOVIL_USERNAME_1 / FACTUREROMOVIL_PASSWORD_1 / FACTUREROMOVIL_NAME_1 (y _2, _3, _4)
const BASE_URL = 'https://app.factureromovil.com';

function facturermovilAccountsFromEnv() {
  const accounts = [];
  for (let i = 1; i <= 4; i++) {
    const username = process.env[`FACTUREROMOVIL_USERNAME_${i}`];
    const password = process.env[`FACTUREROMOVIL_PASSWORD_${i}`];
    const name = process.env[`FACTUREROMOVIL_NAME_${i}`];
    if (username && password && name) accounts.push({ username, password, name });
  }
  return accounts;
}

async function loginFacturermovil(username, password) {
  const r = await fetch(`${BASE_URL}/api/login_check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ _username: username, _password: password }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || `Login falló (status ${r.status})`);
  // La doc no dice el nombre exacto del campo del JWT en la respuesta — probamos los más
  // comunes en este tipo de login Symfony/JWT (token, jwt, access_token).
  const token = data.token || data.jwt || data.access_token;
  if (!token) throw new Error(`Login exitoso pero no se encontró el token en la respuesta: ${JSON.stringify(data)}`);
  return token;
}

// GET /api/invoice-sync/facturero-movil/preview — hace login y trae la respuesta cruda de
// GET /api/documentos de cada cuenta configurada, SIN guardar nada, para confirmar los
// nombres de campo reales antes de mapear la sincronización de verdad.
router.get('/facturero-movil/preview', requireRole('admin'), async (req, res) => {
  const accounts = facturermovilAccountsFromEnv();
  if (accounts.length === 0) {
    return res.status(400).json({ error: 'Falta configurar FACTUREROMOVIL_USERNAME_1 / FACTUREROMOVIL_PASSWORD_1 / FACTUREROMOVIL_NAME_1 (y opcionalmente _2, _3, _4) en Railway.' });
  }

  const preview = [];
  for (const account of accounts) {
    try {
      const token = await loginFacturermovil(account.username, account.password);
      const r = await fetch(`${BASE_URL}/api/documentos`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text.slice(0, 500); }
      preview.push({
        account: account.name,
        login_ok: true,
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
