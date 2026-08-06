const supabase = require('../config/supabase');
const crypto = require('crypto');

/**
 * Verifica el JWT de Supabase Auth O una API key de MCP (para Claude Desktop/API)
 * enviados en el header Authorization, y adjunta el perfil interno (team_members)
 * a req.teamMember.
 */
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'Falta token de autenticación' });
    }

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
        return res.status(401).json({ error: 'API key inválida o revocada' });
      }

      supabase.from('mcp_api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', apiKey.id).then(() => {});

      req.teamMember = apiKey.team_members;
      return next();
    }

    const { data: userData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !userData?.user) {
      return res.status(401).json({ error: 'Token inválido o expirado' });
    }

    const { data: member, error: memberError } = await supabase
      .from('team_members')
      .select('*')
      .eq('auth_user_id', userData.user.id)
      .single();

    if (memberError || !member) {
      return res.status(403).json({ error: 'Usuario sin perfil en el equipo' });
    }

    if (!member.active) {
      return res.status(403).json({ error: 'Usuario desactivado' });
    }

    req.teamMember = member;
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

module.exports = { requireAuth, requireRole };
