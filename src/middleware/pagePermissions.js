// Espejo backend de src/lib/permissions.js del frontend. admin siempre pasa.
// Las páginas no listadas aquí para un rol quedan bloqueadas a nivel de API,
// no solo ocultas en el menú — así nadie se lo salta llamando el endpoint directo.
const ROLE_ALLOWED_PAGES = {
  operaciones: ['deals', 'tasks', 'projects', 'spaces', 'documents', 'activities', 'contactos', 'empresas', 'productos'],
  outbound: ['b2b', 'tasks', 'projects', 'spaces', 'documents', 'activities', 'contactos', 'empresas', 'productos'],
  // Socio externo (ej. Bit WiFi) — ve tratos PERO SOLO del pipeline "Bit WiFi" (bloqueado a
  // nivel de datos en deals.js, no solo de página, para que no pueda ver otros pipelines
  // llamando la API directo), más empresas/contactos/métricas/tareas/espacios/proyectos/
  // documentos. Sin acceso a Bit Prospect, Productos, Facturación ni Forecast.
  wifi_partner: ['deals', 'contactos', 'empresas', 'metricas', 'tasks', 'projects', 'spaces', 'documents'],
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
