// CORS: qué sitios web pueden llamar a la API desde un navegador.
//  · /api/public/*  → CUALQUIER sitio: el formulario de captación se pega en las webs de los clientes y su envío viene de ahí.
//    Es seguro porque no usa sesión ni cookies, y está limitado en tamaño y en cantidad de envíos.
//  · el resto       → solo los orígenes de FRONTEND_ORIGIN (ej. https://crm.bitproximity.com). Sin esa variable se acepta cualquiera
//    (no hay cookies: la sesión viaja en una cabecera, así que otro sitio no puede usarla sin tener el token), y el servidor lo avisa.
// Separado de server.js para que el día que se defina FRONTEND_ORIGIN los formularios incrustados no dejen de funcionar.
const cors = require('cors');

function buildCorsPolicy(frontendOrigin) {
  const allowed = String(frontendOrigin || '*').split(',').map((o) => o.trim()).filter(Boolean);
  const wildcard = allowed.length === 0 || allowed.includes('*');
  // Cada petición con Authorization hace antes una consulta OPTIONS; con maxAge el navegador la recuerda 2 horas (el máximo de Chrome).
  const common = { exposedHeaders: ['Server-Timing'], maxAge: 7200 };
  const publicCors = cors({ ...common, origin: '*' });
  const mainCors = cors({ ...common, origin: wildcard ? '*' : allowed });
  const handler = (req, res, next) => (req.path.startsWith('/api/public/') ? publicCors : mainCors)(req, res, next);
  return { allowed, wildcard, handler };
}

module.exports = { buildCorsPolicy };
