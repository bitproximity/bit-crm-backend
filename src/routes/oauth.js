const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const supabase = require('../config/supabase');

const router = express.Router();

// Estos endpoints los llama Claude.ai directo desde el navegador al conectar
// el conector — necesitan CORS abierto, SOLO en estas rutas (no en el resto de
// la API, que sigue restringida a crm.bitproximity.com vía el CORS global).
router.use((req, res, next) => {
  if (req.path.startsWith('/oauth') || req.path.startsWith('/.well-known')) {
    return cors({ origin: '*' })(req, res, next);
  }
  next();
});
router.use((req, res, next) => {
  if (req.path.startsWith('/oauth') || req.path.startsWith('/.well-known')) {
    return express.json()(req, res, () => express.urlencoded({ extended: true })(req, res, next));
  }
  next();
});

// El servidor MCP de Bit CRM se autentica con una API key propia (bitcrm_mcp_...),
// no con usuario/contraseña. Claude.ai (vía Settings > Connectors) solo sabe hablar
// OAuth 2.1 con conectores remotos, así que este archivo implementa el mínimo de
// OAuth necesario: el usuario pega su API key en una pantalla de "login", y esa
// misma key se devuelve como access_token. requireAuth() en middleware/auth.js no
// necesita ningún cambio: sigue validando el mismo formato bitcrm_mcp_* de siempre.

const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutos
const authCodes = new Map(); // code -> { apiKey, codeChallenge, redirectUri, expiresAt }

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function sha256Base64Url(input) {
  return crypto.createHash('sha256').update(input).digest('base64url');
}

// ── Metadata que Claude.ai consulta primero para descubrir los endpoints ──
router.get('/.well-known/oauth-authorization-server', (req, res) => {
  const issuer = baseUrl(req);
  res.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  });
});

router.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (req, res) => {
  const issuer = baseUrl(req);
  res.json({
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
  });
});

// ── Registro dinámico de cliente: Claude.ai se auto-registra, no hace falta panel ──
router.post('/oauth/register', (req, res) => {
  res.status(201).json({
    client_id: 'bitcrm-mcp-client',
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: req.body?.redirect_uris || [],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
});

// ── Pantalla de "login": pide la API key que ya generaron en Configuración ──
router.get('/oauth/authorize', (req, res) => {
  const { redirect_uri, state, code_challenge, response_type } = req.query;

  if (response_type !== 'code' || !redirect_uri || !code_challenge) {
    return res.status(400).send('Parámetros de OAuth inválidos.');
  }

  res.send(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Conectar Bit CRM con Claude</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0d0d14; color: #f2f2f7; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  form { background: #16161f; border: 1px solid #2a2a38; border-radius: 16px; padding: 32px; width: 340px; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  p { font-size: 13px; color: #9a9aab; margin: 0 0 20px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #2a2a38; background: #0d0d14; color: #fff; font-family: monospace; font-size: 13px; margin-bottom: 14px; }
  button { width: 100%; padding: 10px; border: none; border-radius: 8px; background: linear-gradient(90deg,#7c3aed,#d946ef); color: white; font-weight: 600; font-size: 14px; cursor: pointer; }
  .error { color: #f87171; font-size: 12px; margin-bottom: 10px; }
</style>
</head>
<body>
  <form method="POST" action="/oauth/authorize">
    <h1>Conectar Bit CRM</h1>
    <p>Pega tu API key de Bit CRM (Configuración → Claude / MCP → Generar API key).</p>
    ${req.query.error ? `<div class="error">API key inválida o revocada. Intenta de nuevo.</div>` : ''}
    <input type="text" name="api_key" placeholder="bitcrm_mcp_..." required autofocus />
    <input type="hidden" name="redirect_uri" value="${redirect_uri}" />
    <input type="hidden" name="state" value="${state || ''}" />
    <input type="hidden" name="code_challenge" value="${code_challenge}" />
    <button type="submit">Conectar</button>
  </form>
</body>
</html>`);
});

router.post('/oauth/authorize', async (req, res) => {
  const { api_key, redirect_uri, state, code_challenge } = req.body;

  if (!api_key || !api_key.startsWith('bitcrm_mcp_')) {
    return res.redirect(`/oauth/authorize?${new URLSearchParams({ redirect_uri, state: state || '', code_challenge, response_type: 'code', error: '1' })}`);
  }

  const keyHash = crypto.createHash('sha256').update(api_key).digest('hex');
  const { data: apiKey } = await supabase
    .from('mcp_api_keys')
    .select('id, revoked_at')
    .eq('key_hash', keyHash)
    .is('revoked_at', null)
    .maybeSingle();

  if (!apiKey) {
    return res.redirect(`/oauth/authorize?${new URLSearchParams({ redirect_uri, state: state || '', code_challenge, response_type: 'code', error: '1' })}`);
  }

  const code = crypto.randomBytes(24).toString('hex');
  authCodes.set(code, { apiKey: api_key, codeChallenge: code_challenge, redirectUri: redirect_uri, expiresAt: Date.now() + AUTH_CODE_TTL_MS });

  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
});

// ── Intercambio de código por token: el "access_token" es la misma API key ──
router.post('/oauth/token', (req, res) => {
  const body = { ...req.query, ...req.body };
  const { grant_type, code, code_verifier, refresh_token } = body;

  if (grant_type === 'refresh_token') {
    // La API key no expira, así que el "refresh" simplemente reconfirma el mismo token.
    if (!refresh_token || !refresh_token.startsWith('bitcrm_mcp_')) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    return res.json({ access_token: refresh_token, token_type: 'Bearer', refresh_token, scope: 'mcp' });
  }

  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }

  const entry = authCodes.get(code);
  if (!entry || entry.expiresAt < Date.now()) {
    authCodes.delete(code);
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Código expirado o inválido.' });
  }

  if (entry.codeChallenge) {
    if (!code_verifier || sha256Base64Url(code_verifier) !== entry.codeChallenge) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE inválido.' });
    }
  }

  authCodes.delete(code);
  res.json({
    access_token: entry.apiKey,
    token_type: 'Bearer',
    refresh_token: entry.apiKey,
    scope: 'mcp',
  });
});

module.exports = router;
