const supabase = require('../config/supabase');

/**
 * Verifica el JWT de Supabase Auth enviado en el header Authorization
 * y adjunta el perfil interno (team_members) a req.teamMember.
 */
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'Falta token de autenticación' });
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
