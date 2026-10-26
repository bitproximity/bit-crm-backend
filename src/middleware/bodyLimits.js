// Límites del tamaño de lo que se envía al servidor. Antes eran 50 MB en TODAS las rutas, públicas incluidas: cualquiera podía tumbar el
// servidor mandando cuerpos enormes. Ahora: 64 KB en lo público, 2 MB en casi todo, y 50 MB solo donde de verdad se suben archivos
// (importaciones, lectura de PDF de facturas y documentos con imágenes).
const express = require('express');

const BIG_BODY = /\/(import|parse|bulk)(\/|$)|^\/api\/documents(\/|$)/;
const jsonPublic = express.json({ limit: '64kb' });
const jsonBig = express.json({ limit: '50mb' });
const jsonDefault = express.json({ limit: '2mb' });

function jsonBodyParser(req, res, next) {
  const parser = req.path.startsWith('/api/public/') ? jsonPublic : BIG_BODY.test(req.path) ? jsonBig : jsonDefault;
  return parser(req, res, next);
}

module.exports = { jsonBodyParser, BIG_BODY };
