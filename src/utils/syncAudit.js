const { logAudit } = require('./audit');

// Sincronizaciones: solo se registra cuando de verdad cambió algo. Corren cada 15 min y, sin cambios,
// llenarían «Actividad reciente» con casi 300 entradas vacías por día.
async function logSyncAudit(action, actorId, summary = {}) {
  if (!actorId) return;
  const changed = Number(summary.created || 0) + Number(summary.updated || 0) + Number(summary.failed || 0);
  if (!changed) return;
  await logAudit('invoice_sync', null, action, actorId, summary);
}

module.exports = { logSyncAudit };
