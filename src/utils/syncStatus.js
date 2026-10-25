// Estado de la última sincronización de facturas por fuente (Stripe, Alegra, Facturero Móvil), para
// mostrar en Facturación «última sincronización hace X min» y las diferencias con el origen.
// Vive en memoria: el sincronizador corre 10 s después de arrancar el servidor y cada 15 min, así que
// se vuelve a llenar solo tras cada reinicio.
const state = { sources: {}, last_run_at: null };

function record(source, result = {}) {
  const at = new Date().toISOString();
  state.sources[source] = {
    at,
    ok: !result.error,
    error: result.error || null,
    created: result.created || 0,
    updated: result.updated || 0,
    skipped: result.skipped || 0,
    total_en_origen: result.total_en_alegra ?? result.total_en_stripe ?? result.total ?? null,
    discrepancies: (result.discrepancies || []).slice(0, 100),
  };
  state.last_run_at = at;
}

const get = () => structuredClone(state);
const reset = () => { state.sources = {}; state.last_run_at = null; };

module.exports = { record, get, reset };
