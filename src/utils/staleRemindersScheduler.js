const supabase = require('../config/supabase');
const { createNotification } = require('./notify');
const { todayInTz } = require('./businessDate');
const { loadStale } = require('../routes/staleDeals');

// Una vez al día, cada responsable recibe UN aviso en el CRM con cuántos de sus tratos llevan tiempo sin movimiento
// y cuánto dinero hay en juego, con enlace a la lista para reactivarlos. No crea tareas solo (con cientos de tratos
// abiertos llenaría las listas de todos): las tareas se crean desde la lista, con el botón «Crear recordatorios».
// Un deploy no repite el aviso: se comprueba si esa persona ya recibió el de hoy.
const INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAYS = 14;

async function notifyStaleOwners() {
  try {
    const stale = await loadStale({ days: DAYS });
    const byOwner = new Map();
    for (const d of stale.deals) {
      if (!d.owner_id) continue;
      const o = byOwner.get(d.owner_id) || { count: 0, usd: 0 };
      o.count += 1; o.usd += d.value_usd; byOwner.set(d.owner_id, o);
    }
    const startOfToday = `${todayInTz()}T05:00:00Z`; // 00:00 de Panamá
    let sent = 0;
    for (const [owner, o] of byOwner) {
      const { data: already } = await supabase.from('notifications').select('id').eq('recipient_id', owner).eq('type', 'stale_deals').gte('created_at', startOfToday).limit(1);
      if (already && already.length) continue;
      await createNotification({
        recipient_id: owner, type: 'stale_deals',
        title: `Tienes ${o.count} trato${o.count === 1 ? '' : 's'} sin movimiento (${DAYS}+ días) por USD ${Math.round(o.usd).toLocaleString('en-US')}`,
        body: 'Ábrelos y crea recordatorios para reactivarlos.', link: '/stale-deals',
      });
      sent++;
    }
    if (sent) console.log(`[stale-reminders] ${sent} avisos de tratos sin movimiento enviados`);
  } catch (err) {
    console.error('[stale-reminders] falló:', err.message);
  }
}

function startStaleRemindersScheduler() {
  setTimeout(notifyStaleOwners, 90_000);
  setInterval(notifyStaleOwners, INTERVAL_MS);
  console.log(`[stale-reminders] activo — avisa una vez al día de los tratos con ${DAYS}+ días sin movimiento`);
}

module.exports = { startStaleRemindersScheduler, notifyStaleOwners };
