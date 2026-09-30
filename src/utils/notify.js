const supabase = require('../config/supabase');

// Crea una notificación en la app. Nunca bloquea al que la llama — si falla, solo
// queda en el log del servidor; no debe tumbar la operación principal (asignar una
// tarea, cambiar un trato, etc.) por un problema de notificaciones.
async function createNotification({ recipient_id, type, title, body = null, entity_type = null, entity_id = null, link = null }) {
  if (!recipient_id) return;
  try {
    await supabase.from('notifications').insert({ recipient_id, type, title, body, entity_type, entity_id, link });
  } catch (err) {
    console.error('[notify] no se pudo crear la notificación:', err.message);
  }
}

module.exports = { createNotification };
