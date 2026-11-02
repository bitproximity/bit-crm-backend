// Configuración y autenticación del reporte. No abre conexiones y no usa el cliente de servicio del CRM.
// El secreto vive en REPORTING_API_TOKEN (el valor en claro). Se compara el SHA-256
// del token presentado con el SHA-256 del esperado, en tiempo constante, para que
// un largo distinto no lance ni corte antes.
const crypto = require('crypto');
const parseConnection = require('pg-connection-string').parse;

const QUERY_CREDENTIALS = new Set([
  'token', 'access_token', 'api_key', 'apikey', 'api_token', 'key', 'auth', 'authorization',
]);

function connectionUser(url) {
  try {
    return parseConnection(url).user || '';
  } catch {
    return '';
  }
}

// El usuario tiene que ser el rol cfo_readonly (o cfo_readonly.<project-ref> del pooler).
// Cualquier otro usuario —postgres, el rol de servicio del proyecto, etc.— se trata como mal configurado
// y no se abre el pool.
function isCfoReadonlyUser(user) {
  if (!user || typeof user !== 'string') return false;
  return user.split('.')[0] === 'cfo_readonly';
}

function assessConfig(env = process.env) {
  const url = String(env.REPORTING_DATABASE_URL || '').trim();
  const token = String(env.REPORTING_API_TOKEN || '').trim();
  if (!url || !token) return { ok: false, url: '', token: '' };
  const user = connectionUser(url);
  if (!isCfoReadonlyUser(user)) return { ok: false, url: '', token: '' };
  return { ok: true, url, token, user };
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function tokenMatches(presented, expected) {
  return crypto.timingSafeEqual(digest(presented), digest(expected));
}

// Solo Authorization: Bearer. Un token en la query no cuenta (y ni se lee como secreto).
function bearerFrom(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function tokenAccepted(authorization, expected) {
  const presented = bearerFrom(authorization);
  const matches = tokenMatches(presented || '', expected || '');
  return presented !== null && matches;
}

function credentialInRawQuery(req) {
  const raw = String(req.originalUrl || req.url || '');
  const q = raw.split('?')[1] || '';
  if (!q) return false;
  for (const part of q.split('&')) {
    const eq = part.indexOf('=');
    const rawName = eq === -1 ? part : part.slice(0, eq);
    const rawValue = eq === -1 ? '' : part.slice(eq + 1);
    let name;
    try { name = decodeURIComponent(rawName.replace(/\+/g, ' ')); } catch { return true; }
    if (!QUERY_CREDENTIALS.has(name.toLowerCase())) continue;
    if (rawValue !== '') return true;
  }
  return false;
}

function hasQueryCredential(req) {
  if (credentialInRawQuery(req)) return true;
  const query = req.query || {};
  return Object.keys(query).some((key) => {
    if (!QUERY_CREDENTIALS.has(String(key).toLowerCase())) return false;
    const value = query[key];
    if (Array.isArray(value)) return value.some((item) => item !== undefined && item !== '');
    return value !== undefined && value !== '';
  });
}

function safeError(err) {
  let msg = err && err.message ? String(err.message) : String(err || 'error');
  const secrets = [process.env.REPORTING_DATABASE_URL, process.env.REPORTING_API_TOKEN]
    .map((s) => String(s || '').trim())
    .filter((s) => s.length >= 4);
  try {
    const password = parseConnection(String(process.env.REPORTING_DATABASE_URL || '')).password;
    if (password && String(password).length >= 4) secrets.push(String(password));
  } catch { /* la URL no se pudo leer; no hay contraseña que tapar */ }
  for (const secret of secrets) msg = msg.split(secret).join('[redacted]');
  return msg.slice(0, 500);
}

module.exports = {
  assessConfig,
  isCfoReadonlyUser,
  connectionUser,
  tokenMatches,
  bearerFrom,
  tokenAccepted,
  hasQueryCredential,
  safeError,
};
