// src/routes/prospecting.js
//
// Página "Prospección" del CRM: búsqueda nativa Apollo/Lusha e importación a Listas/tratos.
// Se monta en server.js como: app.use('/api/prospecting', require('./routes/prospecting'));
//
// Solo admin: la búsqueda de Lusha y el revelado de email/teléfono consumen créditos, y la
// página ya está oculta para los demás roles — aquí se cierra también la API, para que nadie
// (ej. un socio externo con login) pueda gastar créditos llamando el endpoint directo.
//
// Las rutas de la herramienta externa «Prospección B2B» viven en routes/prospeccionTool.js.

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePage } = require('../middleware/pagePermissions');
const native = require('./prospectingNative');

const router = express.Router();
router.use(requireAuth);
router.use(requirePage('__admin_only__'));

router.get('/options', native.options);
router.post('/search', native.search);
router.post('/import', native.importCandidates);

module.exports = router;
