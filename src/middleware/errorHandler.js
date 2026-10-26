// Manejo de errores no capturados. Nunca devuelve err.message de un error inesperado: puede traer detalles internos (tablas, rutas, consultas).
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err.status === 413 || err.type === 'entity.too.large') return res.status(413).json({ error: 'El envío es demasiado grande.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'El cuerpo de la petición no es un JSON válido.' });
  console.error('Error no manejado en', req.method, req.originalUrl, ':', err);
  res.status(500).json({ error: 'Error interno del servidor' });
}
module.exports = errorHandler;
