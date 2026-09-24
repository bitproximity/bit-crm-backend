const { syncStripe, syncAlegra } = require('../routes/invoiceSync');
const supabase = require('../config/supabase');

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
    if (result.error) {
      console.warn(`[invoice-scheduler] ${label}: ${result.error}`);
    } else {
      console.log(`[invoice-scheduler] ${label}: +${result.created} nuevas, ${result.skipped} ya existían`);
    }
  } catch (err) {
    console.error(`[invoice-scheduler] ${label} falló:`, err.message);
  }
}

function startInvoiceScheduler() {
  // Corre una vez al arrancar el servidor (deploys frecuentes en este proyecto = sync
  // frecuente igual, sin esperar los 15 minutos), y despues cada INTERVAL_MS.
  setTimeout(() => {
    runOnce('Stripe', syncStripe);
    runOnce('Alegra', syncAlegra);
  }, 10_000); // 10s de margen para que el server termine de levantar

  setInterval(() => {
    runOnce('Stripe', syncStripe);
    runOnce('Alegra', syncAlegra);
  }, INTERVAL_MS);

  console.log(`[invoice-scheduler] activo — sincroniza Stripe y Alegra cada ${INTERVAL_MS / 60000} minutos`);
}

module.exports = { startInvoiceScheduler };
