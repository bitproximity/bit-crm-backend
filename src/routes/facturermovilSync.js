const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { logAudit } = require('../utils/audit');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// Facturero Móvil (Ecuador) — se autentica con usuario/clave (no un token fijo):
// POST /api/login_check devuelve un JWT que hay que usar en las llamadas siguientes.
// Cada emisor (Mario Ramos, Hector Mario Ramos, Diana Sanchez, etc.) tiene su propio
// usuario — se soportan hasta 4 cuentas.
// A diferencia de Stripe/Alegra, GET /api/documentos NO trae estado de pago (Facturero
// Móvil solo emite el comprobante legal ante el SRI, no lleva cuentas por cobrar) — todo
// llega como "pendiente" salvo que el SRI lo marque "ANULADO", y el pago se marca a mano
// desde Facturación (el toggle de un clic). También, a diferencia de las otras dos fuentes,
// solo se trae 2025 en adelante (a pedido explícito, el historial de esta cuenta arranca
// en 2021 y no todo es relevante).
// Doc: https://app.factureromovil.com/api/doc
//   FACTUREROMOVIL_USERNAME_N / FACTUREROMOVIL_PASSWORD_N / FACTUREROMOVIL_NAME_N (N: 1-4)
const BASE_URL = process.env.FACTUREROMOVIL_BASE_URL || 'https://app.factureromovil.com';
const MIN_YEAR = 2025;

function facturermovilAccountsFromEnv() {
  const accounts = [];
  for (let i = 1; i <= 4; i++) {
    const username = process.env[`FACTUREROMOVIL_USERNAME_${i}`];
    const password = process.env[`FACTUREROMOVIL_PASSWORD_${i}`];
    const name = process.env[`FACTUREROMOVIL_NAME_${i}`];
    if (username && password && name) accounts.push({ index: i, username, password, name });
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
  const token = data.token || data.jwt || data.access_token;
  if (!token) throw new Error(`Login exitoso pero no se encontró el token en la respuesta: ${JSON.stringify(data)}`);
  return token;
}

async function insertInvoiceTolerant(payload) {
  let body = { ...payload };
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await supabase.from('invoices').insert(body).select().single();
    if (!result.error) return result;
    const match = /Could not find the '(\w+)' column/.exec(result.error.message || '');
    if (!match || !(match[1] in body)) return result;
    delete body[match[1]];
  }
  return { error: { message: 'No se pudo guardar la factura.' } };
}

async function syncFacturermovil(actorId) {
  const accounts = facturermovilAccountsFromEnv();
  if (accounts.length === 0) return { error: 'Falta configurar FACTUREROMOVIL_USERNAME_1 / FACTUREROMOVIL_PASSWORD_1 / FACTUREROMOVIL_NAME_1 en Railway.' };

  let totalCreated = 0, totalSkipped = 0, totalSeen = 0;
  const perAccount = [];

  for (const account of accounts) {
    let token;
    try {
      token = await loginFacturermovil(account.username, account.password);
    } catch (err) {
      perAccount.push({ account: account.name, error: `Login: ${err.message}` });
      continue;
    }

    let docs = [];
    for (let offset = 0; offset <= 20000; offset += 100) {
      const r = await fetch(`${BASE_URL}/api/documentos?limit=100&offset=${offset}`, { headers: { Authorization: `Bearer ${token}` } });
      const batch = await r.json();
      if (!r.ok || !Array.isArray(batch)) {
        perAccount.push({ account: account.name, error: `Error consultando documentos (status ${r.status}, offset ${offset})` });
        docs = null;
        break;
      }
      docs = docs.concat(batch);
      if (batch.length < 100) break; // última página
    }
    if (!docs) continue;

    const sourceKey = `facturero_movil:${account.index}`;
    let created = 0, skipped = 0, fuera_de_rango = 0;
    for (const doc of docs) {
      if (doc.codigoSri !== '01') continue; // solo facturas — no notas de crédito/débito/retenciones
      const issueDate = (doc.fechaEmision || '').slice(0, 10); // "2021-06-07T00:00:00-05:00" -> "2021-06-07"
      const year = Number(issueDate.slice(0, 4));
      if (!year || year < MIN_YEAR) { fuera_de_rango++; continue; }

      const { data: existing } = await supabase.from('invoices').select('id').eq('external_source', sourceKey).eq('external_id', String(doc.id)).maybeSingle();
      if (existing) { skipped++; continue; }

      const { error } = await insertInvoiceTolerant({
        invoice_number: doc.numeroDocumento,
        currency: 'USD',
        subtotal: Number(doc.valor || 0),
        tax: 0,
        total: Number(doc.valor || 0),
        paid_amount: 0,
        status: doc.estado === 'ANULADO' ? 'cancelada' : 'pendiente',
        issue_date: issueDate,
        due_date: issueDate,
        notes: `Importado de Facturero Móvil (${account.name}) - ${doc.razonSocial || 'Sin nombre'}`,
        source_account: account.name,
        external_source: sourceKey,
        external_id: String(doc.id),
        created_by: actorId,
      });
      if (!error) created++;
    }

    perAccount.push({ account: account.name, created, skipped, fuera_de_rango, total_en_cuenta: docs.length });
    totalCreated += created;
    totalSkipped += skipped;
    totalSeen += docs.length;
  }

  if (actorId) await logAudit('invoice_sync', null, 'facturero_movil_sync', actorId, { created: totalCreated, skipped: totalSkipped, per_account: perAccount });
  return { created: totalCreated, skipped: totalSkipped, total_visto: totalSeen, per_account: perAccount };
}

router.post('/facturero-movil', requireRole('admin'), async (req, res) => {
  const result = await syncFacturermovil(req.teamMember.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// GET /api/invoice-sync/facturero-movil/preview — sigue disponible para depurar cuentas
// nuevas antes de correr la sincronización de verdad.
router.get('/facturero-movil/preview', requireRole('admin'), async (req, res) => {
  const accounts = facturermovilAccountsFromEnv();
  if (accounts.length === 0) {
    return res.status(400).json({ error: 'Falta configurar FACTUREROMOVIL_USERNAME_1 / FACTUREROMOVIL_PASSWORD_1 / FACTUREROMOVIL_NAME_1 (y opcionalmente _2, _3, _4) en Railway.' });
  }
  const preview = [];
  for (const account of accounts) {
    try {
      const token = await loginFacturermovil(account.username, account.password);
      const urls = {
        limit100_offset0: `${BASE_URL}/api/documentos?limit=100&offset=0`,
        limit100_offset100: `${BASE_URL}/api/documentos?limit=100&offset=100`,
        limit100_start100: `${BASE_URL}/api/documentos?limit=100&start=100`,
        limit100_skip100: `${BASE_URL}/api/documentos?limit=100&skip=100`,
      };
      const results = {};
      for (const [label, url] of Object.entries(urls)) {
        const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        const data = await r.json().catch(() => null);
        results[label] = {
          status: r.status,
          count: Array.isArray(data) ? data.length : null,
          primer_id: Array.isArray(data) && data[0] ? data[0].id : null,
          ultimo_id: Array.isArray(data) && data.length ? data[data.length - 1].id : null,
        };
      }
      preview.push({ account: account.name, login_ok: true, resultados: results });
    } catch (err) {
      preview.push({ account: account.name, error: err.message });
    }
  }
  res.json(preview);
});

// GET /api/invoice-sync/facturero-movil/paginate-test — prueba varias convenciones de
// paginación contra la primera cuenta configurada, para averiguar cuál usa esta API real
// (la doc pública no lo dice) antes de asumir una y traer datos incompletos.
router.get('/facturero-movil/paginate-test', requireRole('admin'), async (req, res) => {
  const accounts = facturermovilAccountsFromEnv();
  if (accounts.length === 0) return res.status(400).json({ error: 'Sin cuentas configuradas.' });
  const account = accounts[0];

  let token;
  try {
    token = await loginFacturermovil(account.username, account.password);
  } catch (err) {
    return res.status(400).json({ error: `Login: ${err.message}` });
  }

  const attempts = [
    { label: 'sin parámetros', qs: '' },
    { label: 'page=2', qs: '?page=2' },
    { label: 'page=1&limit=100', qs: '?page=1&limit=100' },
    { label: 'limit=1000', qs: '?limit=1000' },
    { label: 'itemsPerPage=1000', qs: '?itemsPerPage=1000' },
    { label: 'offset=5', qs: '?offset=5' },
    { label: 'pageSize=1000', qs: '?pageSize=1000' },
    { label: 'per_page=1000', qs: '?per_page=1000' },
    { label: 'fechaInicio/fechaFin', qs: '?fechaInicio=2025-01-01&fechaFin=2026-12-31' },
  ];

  const results = [];
  for (const attempt of attempts) {
    try {
      const r = await fetch(`${BASE_URL}/api/documentos${attempt.qs}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await r.json();
      results.push({ intento: attempt.label, status: r.status, count: Array.isArray(data) ? data.length : null, primer_id: Array.isArray(data) && data[0] ? data[0].id : null, ultimo_id: Array.isArray(data) && data.length ? data[data.length - 1].id : null });
    } catch (err) {
      results.push({ intento: attempt.label, error: err.message });
    }
  }
  res.json({ account: account.name, results });
});

module.exports = router;
module.exports.syncFacturermovil = syncFacturermovil;
