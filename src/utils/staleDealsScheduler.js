const supabase = require('../config/supabase');
const { fetchAll } = require('./fetchAll');
const { executeAction } = require('./automations');

const INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 día

// Revisa las reglas "sin actividad hace N días" y dispara la acción para cada trato
// abierto que lleve más de N días sin cambios. automation_triggers_log (unique por
// regla+trato) evita avisar del mismo trato todos los días una vez que ya se avisó.
async function checkStaleDeals() {
  try {
    const { data: rules } = await supabase.from('automation_rules').select('*').eq('trigger_type', 'deal_stale').eq('active', true);
    let disparadas = 0;
    for (const rule of rules || []) {
      const days = Number(rule.trigger_config?.days) || 7;
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      let query = supabase.from('deals').select('*').eq('status', 'abierto').lt('updated_at', cutoff);
      if (rule.trigger_config?.pipeline_id) query = query.eq('pipeline_id', rule.trigger_config.pipeline_id);
      const { data: staleDeals } = await fetchAll(query);

      for (const deal of staleDeals || []) {
        const { error: dupError } = await supabase.from('automation_triggers_log').insert({ rule_id: rule.id, deal_id: deal.id });
        if (dupError) continue; // ya se avisó antes de este trato con esta regla
        await executeAction(rule, deal);
        disparadas++;
      }
    }
    if (disparadas) console.log(`[stale-deals] ${disparadas} avisos de tratos sin actividad disparados`);
  } catch (err) {
    console.error('[stale-deals] falló la revisión:', err.message);
  }
}

function startStaleDealsScheduler() {
  setTimeout(checkStaleDeals, 30_000);
  setInterval(checkStaleDeals, INTERVAL_MS);
  console.log('[stale-deals] activo — revisa tratos sin actividad una vez al día');
}

module.exports = { startStaleDealsScheduler };
