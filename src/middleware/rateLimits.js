// Límites de peticiones. Sin esto, cualquiera podía enviar miles de formularios públicos (cada uno crea empresa + contacto + trato y
// manda correo a los administradores) o martillar la API.
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const base = { standardHeaders: 'draft-7', legacyHeaders: false, validate: false };
const byIp = (req) => `ip:${req.ip}`;
// Con sesión, el límite es POR PERSONA (así una oficina entera detrás de una misma IP no se limita entre sí); sin sesión, por IP.
const byCaller = (req) => {
  const auth = req.headers.authorization;
  return auth ? `u:${crypto.createHash('sha1').update(auth).digest('hex')}` : byIp(req);
};
const msg = (text) => ({ error: text });

// API y MCP: generoso (la pantalla se actualiza sola cada 30-60 s); solo frena un script desbocado.
const makeApiLimiter = (limit = 1500) => rateLimit({ ...base, windowMs: 60 * 1000, limit, keyGenerator: byCaller, skip: (req) => req.method === 'OPTIONS', message: msg('Demasiadas peticiones seguidas. Espera un momento e intenta de nuevo.') });
const apiLimiter = makeApiLimiter();
// Enviar un formulario público: pocas veces por hora y por IP.
const publicFormSubmitLimiter = rateLimit({ ...base, windowMs: 60 * 60 * 1000, limit: 10, keyGenerator: byIp, message: msg('Has enviado demasiados formularios. Intenta de nuevo más tarde.') });
// Leer lo público (definición del formulario, reporte compartido): evita que se enumeren o raspen.
const publicReadLimiter = rateLimit({ ...base, windowMs: 60 * 1000, limit: 120, keyGenerator: byIp, message: msg('Demasiadas peticiones. Intenta de nuevo en un minuto.') });

module.exports = { apiLimiter, makeApiLimiter, publicFormSubmitLimiter, publicReadLimiter };
