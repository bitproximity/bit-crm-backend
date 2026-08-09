// Espejo backend de src/lib/permissions.js del frontend. admin siempre pasa.
// Las páginas no listadas aquí para un rol quedan bloqueadas a nivel de API,
// no solo ocultas en el menú — así nadie se lo salta llamando el endpoint directo.
const ROLE_ALLOWED_PAGES = {
  operaciones: ['deals', 'tasks', 'projects', 'spaces', 'documents', 'activities'],
  outbound: ['b2b', 'tasks', 'projects', 'spaces', 'documents', 'activities'],
};

function requirePage(pageKey) {
  return (req, res, next) => {
    const role = req.teamMember?.role;
    if (role === 'admin') return next();
    const allowed = ROLE_ALLOWED_PAGES[role];
    if (allowed && allowed.includes(pageKey)) return next();
    return res.status(403).json({ error: 'Tu rol no tiene acceso a esta sección del CRM.' });
  };
}

module.exports = { requirePage };
