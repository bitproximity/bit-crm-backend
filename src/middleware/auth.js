const supabase = require('../config/supabase');
const crypto = require('crypto');

// Evita repetir la validación (2 round-trips de red a Supabase) cuando el mismo token hace
// varias llamadas — cada pantalla del CRM dispara varias de una vez.
//  - TTL de sesión (JWT): 3 min. Seguimos validando contra Supabase Auth (getUser), así que una
//    sesión cerrada o un usuario desactivado se respeta como mucho tras ese tiempo — y al instante
//    cuando el cambio pasa por este backend (ver clearAuthCache, llamado desde server.js).
//  - TTL de API keys (MCP): 60 s, para que una key revocada deje de servir rápido.
const AUTH_CACHE_TTL_MS = Number(process.env.AUTH_CACHE_TTL_MS) || 3 * 60 * 1000;
const KEY_CACHE_TTL_MS = Number(process.env.KEY_CACHE_TTL_MS) || 60 * 1000;
const authCache = new Map(); // token -> { teamMember, expiresAt }
// Validaciones en curso: si llegan 6 peticiones a la vez con el mismo token (carga de pantalla),
// solo una consulta a Supabase y las otras 5 esperan ese mismo resultado.
const authInflight = new Map(); // token -> Promise<{ member } | { status, error }>
// Sube con cada clearAuthCache(): una validación que estaba en curso cuando alguien cambió/desactivó
// a un usuario NO debe volver a guardar el dato viejo al terminar.
let authGeneration = 0;

function getCached(token) {
  const entry = authCache.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    authCache.delete(token);
    return null;
  }
  return entry.teamMember;
}

function setCached(token, teamMember, ttlMs = AUTH_CACHE_TTL_MS) {
  authCache.set(token, { teamMember, expiresAt: Date.now() + ttlMs });
  // Evita que el Map crezca sin límite en un proceso de larga duración
  if (authCache.size > 500) {
    const oldestKey = authCache.keys().next().value;
    authCache.delete(oldestKey);
  }
}

// Vacía lo recordado (al cambiar/desactivar un usuario, su rol o bloqueos, o al revocar una key).
function clearAuthCache() {
  authGeneration++;
  authCache.clear();
  authInflight.clear();
}

// Valida un token y devuelve { member } o { status, error }. Sin tocar req/res, para poder
// compartir el resultado entre peticiones simultáneas.
async function resolveToken(token) {
  const gen = authGeneration;
  // Las API keys de MCP tienen el prefijo 'bitcrm_mcp_' — se validan aparte del JWT
  if (token.startsWith('bitcrm_mcp_')) {
    const keyHash = crypto.createHash('sha256').update(token).digest('hex');

    const { data: apiKey } = await supabase
      .from('mcp_api_keys')
      .select('*, team_members(*)')
      .eq('key_hash', keyHash)
      .is('revoked_at', null)
      .maybeSingle();

    if (!apiKey || !apiKey.team_members?.active) {
      return { status: 401, error: 'API key inválida o revocada' };
    }

    supabase.from('mcp_api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', apiKey.id).then(() => {});
    if (gen === authGeneration) setCached(token, apiKey.team_members, KEY_CACHE_TTL_MS);
    return { member: apiKey.team_members };
  }

  const { data: userData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !userData?.user) {
    return { status: 401, error: 'Token inválido o expirado' };
  }

  const { data: members, error: memberError } = await supabase
    .from('team_members')
    .select('*')
    .eq('auth_user_id', userData.user.id)
    .order('created_at', { ascending: true });

  // .single() fallaba (y devolvía "sin perfil") tanto si no había fila como si por algún
  // motivo había MÁS DE UNA con el mismo auth_user_id — un 403 intermitente y difícil de
  // diagnosticar. Ahora se toleran duplicados: se usa la primera activa, o la primera que
  // haya, en vez de romper con un solo caso ambiguo.
  if (memberError || !members || members.length === 0) {
    return { status: 403, error: 'Usuario sin perfil en el equipo' };
  }
  const member = members.find((m) => m.active) || members[0];

  if (!member.active) {
    return { status: 403, error: 'Usuario desactivado' };
  }

  if (gen === authGeneration) setCached(token, member);
  return { member };
}

/**
 * Verifica el JWT de Supabase Auth O una API key de MCP (para Claude Desktop/API)
 * enviados en el header Authorization, y adjunta el perfil interno (team_members)
 * a req.teamMember.
 */
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    // El endpoint /mcp necesita indicar, en el header WWW-Authenticate, dónde
    // está la metadata OAuth — sin esto el cliente de Claude.ai no puede
    // descubrir el servidor de autorización y nunca llega a intentar conectar.
    const addAuthHeader = () => {
      if (req.path === '/mcp' || req.originalUrl === '/mcp') {
        const issuer = `${req.protocol}://${req.get('host')}`;
        res.set('WWW-Authenticate', `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`);
      }
    };

    if (!token) {
      addAuthHeader();
      return res.status(401).json({ error: 'Falta token de autenticación' });
    }

    const cached = getCached(token);
    if (cached) {
      if (!cached.active) return res.status(403).json({ error: 'Usuario desactivado' });
      req.teamMember = cached;
      return next();
    }

    let pending = authInflight.get(token);
    if (!pending) {
      pending = resolveToken(token).finally(() => authInflight.delete(token));
      authInflight.set(token, pending);
    }
    const result = await pending;

    if (result.error) {
      if (result.status === 401) addAuthHeader();
      return res.status(result.status).json({ error: result.error });
    }

    req.teamMember = result.member;
    next();
  } catch (err) {
    console.error('Error en requireAuth:', err);
    res.status(500).json({ error: 'Error validando autenticación' });
  }
}

/**
 * Restringe una ruta a ciertos roles.
 * Uso: router.delete('/:id', requireAuth, requireRole('admin'), handler)
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.teamMember || !allowedRoles.includes(req.teamMember.role)) {
      return res.status(403).json({ error: 'No tienes permisos para esta acción' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, clearAuthCache };
