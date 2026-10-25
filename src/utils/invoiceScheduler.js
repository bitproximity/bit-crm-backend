const { syncStripe, syncAlegra } = require('../routes/invoiceSync');
const { syncFacturermovil } = require('../routes/facturermovilSync');
const supabase = require('../config/supabase');
const syncStatus = require('./syncStatus');
const { clearAll: clearMemo } = require('./memo');
const { applyAutoLinks } = require('./invoiceLinker');

// Corre la sincronización de facturas SOLA cada cierto tiempo — Mario ya no necesita
// apretar "Sincronizar" a mano, cada factura nueva de Stripe o Alegra llega al CRM por
// defecto. Se usa el primer admin como "actor" de la corrida automática (no null, para que
// created_by quede con un valor real y no falle si la columna es obligatoria).
const INTERVAL_MS = 15 * 60 * 1000; // 15 minutos

let systemActorId = null;
async function getSystemActorId() {
  if (systemActorId) return systemActorId;
  const { data } = await supabase.from('team_members').select('id').eq('role', 'admin').order('created_at', { ascending: true }).limit(1).maybeSingle();
  systemActorId = data?.id || null;
  return systemActorId;
}

async function runOnce(label, fn) {
  try {
    const actorId = await getSystemActorId();
    const result = await fn(actorId);
    syncStatus.record(label, result);
    if (result.error) {
      console.warn(`[invoice-scheduler] ${label}: ${result.error}`);
    } else {
      const diff = (result.discrepancies || []).length;
      console.log(`[invoice-scheduler] ${label}: +${result.created} nuevas, ${result.updated || 0} actualizadas, ${result.skipped} sin cambios${diff ? `, ${diff} diferencias con el origen` : ''}`);
      if (result.created || result.updated) clearMemo(); // para que el Dashboard y las métricas vean el cambio al instante, no en 20 s
    }
  } catch (err) {
    console.error(`[invoice-scheduler] ${label} falló:`, err.message);
  }
}

// Deja vinculadas (a su empresa y al trato ganado) las facturas que llegaron en los últimos días, solo cuando el
// vínculo es casi seguro. El histórico NO se toca solo: se revisa y se vincula con el botón de Conciliación.
async function linkNewInvoices() {
  try {
    const actorId = await getSystemActorId();
    const r = await applyAutoLinks({ createdSince: new Date(Date.now() - 3 * 86400000).toISOString(), actorId });
    if (r.linked_deals || r.linked_companies) {
      console.log(`[invoice-scheduler] vinculación: ${r.linked_deals} facturas a su trato ganado, ${r.linked_companies} a su empresa`);
      clearMemo();
    }
  } catch (err) {
    console.error('[invoice-scheduler] vinculación falló:', err.message);
  }
}

async function runAll() {
  await runOnce('Stripe', syncStripe);
  await runOnce('Alegra', syncAlegra);
  await runOnce('Facturero Movil', syncFacturermovil);
  await linkNewInvoices();
}

function startInvoiceScheduler() {
  // Corre una vez al arrancar el servidor (deploys frecuentes en este proyecto = sync
  // frecuente igual, sin esperar los 15 minutos), y despues cada INTERVAL_MS.
  setTimeout(runAll, 10_000); // 10s de margen para que el server termine de levantar
  setInterval(runAll, INTERVAL_MS);

  console.log(`[invoice-scheduler] activo — sincroniza Stripe y Alegra cada ${INTERVAL_MS / 60000} minutos`);
}

module.exports = { startInvoiceScheduler, runAll };
