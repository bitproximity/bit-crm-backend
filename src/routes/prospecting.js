// src/routes/prospecting.js
//
// Página "Prospección" del CRM: búsqueda nativa Apollo/Lusha e importación.
// Se monta en server.js como: app.use('/api/prospecting', require('./routes/prospecting'));
//
// Las rutas de la herramienta externa «Prospección B2B» (proxy de IA, leads
// del equipo) viven ahora en routes/prospeccionTool.js, montado en
// /api/prospeccion-tool y protegido con requireAuth. Aquí ya no queda
// /save-to-crm, /pipeline-snapshot, /contacted ni el /search por prompt:
// estaban sin autenticación.

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const native = require('./prospectingNative');

const router = express.Router();

// La página manda { provider, title|department, country } (sin prompt).
router.post('/import', requireAuth, native.importCandidates);
router.post('/search', requireAuth, native.search);

module.exports = router;
