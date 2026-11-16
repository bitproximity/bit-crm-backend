const supabase = require('../config/supabase');

/**
 * Registra una entrada en audit_log. Se llama desde cada ruta que
 * crea/actualiza/borra/mueve algo, para mantener trazabilidad total.
 *
 * @param {string} entityType - 'contact' | 'company' | 'deal' | 'task' | 'project'
 * @param {string} entityId
 * @param {string} action - 'created' | 'updated' | 'deleted' | 'stage_changed' | 'status_changed' | 'assigned'
 * @param {string} actorId - team_members.id de quien hizo el cambio
 * @param {object} [changes] - { campo: { from, to } }
 */
// audit_log.entity_id es NOT NULL: los eventos que no apuntan a un registro concreto (p. ej. una
// sincronización de facturas) usan este id «vacío». Antes iban con null y la base los rechazaba.
const NO_ENTITY = '00000000-0000-0000-0000-000000000000';

async function logAudit(entityType, entityId, action, actorId, changes = null) {
  const { error } = await supabase.from('audit_log').insert({
    entity_type: entityType,
    entity_id: entityId || NO_ENTITY,
    action,
    actor_id: actorId,
    changes,
  });

  if (error) {
    // No se detiene la request principal por un fallo de auditoría,
    // pero se deja registrado en logs para no perder trazabilidad silenciosamente.
    console.error('Error registrando audit_log:', error);
  }
}

module.exports = { logAudit, NO_ENTITY };
