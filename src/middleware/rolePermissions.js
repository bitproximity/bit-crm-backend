const supabase = require('../config/supabase');

// Lista de recursos con permisos configurables desde Configuración > Permisos.
// Agregar uno nuevo acá (y sembrar filas para él en una migración) es todo lo que hace
// falta para que aparezca en el panel — no hay que tocar el resto de este archivo.
const KNOWN_RESOURCES = ['automations'];

async function resolvePermissions(role) {
  if (role === 'admin') {
    return Object.fromEntries(KNOWN_RESOURCES.map((r) => [r, { can_view: true, can_manage: true }]));
  }
  const { data } = await supabase.from('role_permissions').select('*').eq('role', role);
  const byResource = Object.fromEntries((data || []).map((row) => [row.resource, { can_view: row.can_view, can_manage: row.can_manage }]));
  // Un rol sin fila para un recurso (uno nuevo que todavía no se sembró) queda sin acceso,
  // no con acceso por accidente.
  KNOWN_RESOURCES.forEach((r) => { byResource[r] ||= { can_view: false, can_manage: false }; });
  return byResource;
}

// level: 'view' o 'manage'. admin siempre pasa.
function requirePermission(resource, level = 'view') {
  return async (req, res, next) => {
    const role = req.teamMember?.role;
    if (role === 'admin') return next();
    const { data } = await supabase.from('role_permissions').select('can_view, can_manage').eq('role', role).eq('resource', resource).maybeSingle();
    const allowed = level === 'manage' ? data?.can_manage : (data?.can_view || data?.can_manage);
    if (allowed) return next();
    return res.status(403).json({ error: 'Tu rol no tiene permiso para esta sección.' });
  };
}

module.exports = { requirePermission, resolvePermissions, KNOWN_RESOURCES };
