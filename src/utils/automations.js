const supabase = require('../config/supabase');
const { createNotification } = require('./notify');

// Sustituye {{trato}} por el título real del trato en el texto de una regla.
function render(str, deal) {
  return String(str || '').replaceAll('{{trato}}', deal?.title || 'un trato');
}

function resolveRecipient(config, deal) {
  const who = config.assignee || config.recipient;
  if (who === 'owner') return deal.owner_id || null;
  return who || null;
}

async function executeAction(rule, deal) {
  const recipientId = resolveRecipient(rule.action_config || {}, deal);
  if (!recipientId) return;

  if (rule.action_type === 'create_task') {
    const title = render(rule.action_config.title, deal);
    const daysOffset = Number(rule.action_config.days_offset) || 0;
    const dueDate = new Date(Date.now() + daysOffset * 86400000).toISOString();
    const { data: task, error } = await supabase
      .from('tasks')
      .insert({ title, assignee_id: recipientId, due_date: dueDate, created_by: rule.created_by })
      .select()
      .single();
    if (error) { console.error('[automations] no se pudo crear la tarea:', error.message); return; }
    createNotification({
      recipient_id: recipientId, type: 'automation_task',
      title: `Tarea automática: "${title}"`, body: `Regla: ${rule.name}`,
      entity_type: 'task', entity_id: task.id, link: '/tasks',
    });
  } else if (rule.action_type === 'notify') {
    createNotification({
      recipient_id: recipientId, type: 'automation',
      title: render(rule.action_config.message, deal), body: `Regla: ${rule.name}`,
      entity_type: 'deal', entity_id: deal.id, link: `/deals/${deal.id}`,
    });
  }
}

async function runRules(triggerType, deal, matchFn) {
  if (!deal) return;
  try {
    const { data: rules } = await supabase.from('automation_rules').select('*').eq('trigger_type', triggerType).eq('active', true);
    for (const rule of rules || []) {
      if (!matchFn(rule.trigger_config || {})) continue;
      await executeAction(rule, deal).catch((err) => console.error('[automations] falló una acción:', err.message));
    }
  } catch (err) {
    console.error('[automations] no se pudieron evaluar las reglas:', err.message);
  }
}

// Se llama al mover un trato de etapa (deals.js PATCH /:id/stage).
async function fireStageChanged(deal, toStageId) {
  await runRules('stage_changed', deal, (cfg) => cfg.to_stage_id === toStageId);
}

// Se llama al ganar/perder un trato (deals.js POST /:id/win y /:id/lose).
async function fireStatusChanged(deal, status) {
  await runRules('status_changed', deal, (cfg) => cfg.status === status);
}

module.exports = { fireStageChanged, fireStatusChanged, runRules, executeAction };
