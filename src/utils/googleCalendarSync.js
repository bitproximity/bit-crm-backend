const { google } = require('googleapis');
const supabase = require('../config/supabase');
const { getOAuthClient } = require('../config/googleOAuth');

const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || 'https://crm.bitproximity.com';

async function getCalendarClientForUser(teamMemberId) {
  const { data: conn } = await supabase
    .from('gmail_connections')
    .select('refresh_token, email')
    .eq('team_member_id', teamMemberId)
    .maybeSingle();

  if (!conn?.refresh_token) return null; // no conectó su Google, no hay nada que sincronizar

  const client = getOAuthClient();
  client.setCredentials({ refresh_token: conn.refresh_token });
  return { calendar: google.calendar({ version: 'v3', auth: client }), email: conn.email };
}

// Crea, actualiza o borra el evento de Google Calendar de una tarea, según corresponda.
// Devuelve { ok: true, ... } o { ok: false, reason: '<motivo>' } — nunca lanza, para que
// el llamado "en segundo plano" (fire-and-forget) nunca tumbe la creación/edición de la tarea.
async function syncTaskToCalendar(task) {
  try {
    if (!task.assignee_id) return { ok: false, reason: 'La tarea no tiene responsable asignado.' };

    const conn = await getCalendarClientForUser(task.assignee_id);
    if (!conn) return { ok: false, reason: 'El responsable de la tarea no tiene su Google conectado (Mi Perfil → Gmail + Google Calendar).' };
    const { calendar, email } = conn;

    const shouldHaveEvent = !!task.due_date && task.status !== 'completada';

    if (!shouldHaveEvent) {
      if (task.google_event_id) {
        await calendar.events.delete({ calendarId: 'primary', eventId: task.google_event_id }).catch(() => {});
        await supabase.from('tasks').update({ google_event_id: null }).eq('id', task.id);
      }
      return { ok: false, reason: !task.due_date ? 'La tarea no tiene fecha límite.' : 'La tarea ya está completada.' };
    }

    const start = new Date(task.due_date);
    const end = new Date(start.getTime() + 30 * 60000); // bloque de 30 min por defecto

    const eventBody = {
      summary: `📋 ${task.title}`,
      description: `Tarea de Bit CRM${task.priority && task.priority !== 'media' ? ` · Prioridad ${task.priority}` : ''}\n\nVer en el CRM: ${PUBLIC_APP_URL}/tasks`,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 30 },
          { method: 'email', minutes: 60 },
        ],
      },
    };

    let eventLink;
    if (task.google_event_id) {
      try {
        const { data } = await calendar.events.update({ calendarId: 'primary', eventId: task.google_event_id, requestBody: eventBody });
        eventLink = data.htmlLink;
      } catch (err) {
        // El evento pudo haber sido borrado a mano en Google Calendar — creamos uno nuevo
        const { data } = await calendar.events.insert({ calendarId: 'primary', requestBody: eventBody });
        await supabase.from('tasks').update({ google_event_id: data.id }).eq('id', task.id);
        eventLink = data.htmlLink;
      }
    } else {
      const { data } = await calendar.events.insert({ calendarId: 'primary', requestBody: eventBody });
      await supabase.from('tasks').update({ google_event_id: data.id }).eq('id', task.id);
      eventLink = data.htmlLink;
    }

    return { ok: true, eventLink, connectedEmail: email };
  } catch (err) {
    console.error('Error sincronizando tarea con Google Calendar:', task.id, err.message);
    return { ok: false, reason: err.message };
  }
}

async function deleteTaskFromCalendar(task) {
  try {
    if (!task.assignee_id || !task.google_event_id) return;
    const conn = await getCalendarClientForUser(task.assignee_id);
    if (!conn) return;
    await conn.calendar.events.delete({ calendarId: 'primary', eventId: task.google_event_id }).catch(() => {});
  } catch (err) {
    console.error('Error borrando evento de Google Calendar:', err.message);
  }
}

const ACTIVITY_TYPE_ICON = { llamada: '📞', email: '✉️', reunion: '🤝', nota: '📝', whatsapp: '💬', tarea: '✅' };

// Crea, actualiza o borra el evento de Google Calendar de una actividad (llamada, reunión, etc.)
// registrada en el detalle de un trato/contacto/empresa. Mismo criterio que syncTaskToCalendar:
// nunca lanza, para no tumbar el guardado de la actividad si el calendario falla.
async function syncActivityToCalendar(activity) {
  try {
    if (!activity.author_id) return { ok: false, reason: 'La actividad no tiene autor.' };

    const conn = await getCalendarClientForUser(activity.author_id);
    if (!conn) return { ok: false, reason: 'No tienes tu Google conectado (Mi Perfil → Gmail + Google Calendar).' };
    const { calendar, email } = conn;

    const shouldHaveEvent = !!activity.due_date && !activity.done;

    if (!shouldHaveEvent) {
      if (activity.google_event_id) {
        await calendar.events.delete({ calendarId: 'primary', eventId: activity.google_event_id }).catch(() => {});
        await supabase.from('activities').update({ google_event_id: null }).eq('id', activity.id);
      }
      return { ok: false, reason: !activity.due_date ? 'La actividad no tiene fecha/hora.' : 'La actividad ya está completada.' };
    }

    const start = new Date(activity.due_date);
    const end = new Date(start.getTime() + 30 * 60000); // bloque de 30 min por defecto
    const icon = ACTIVITY_TYPE_ICON[activity.type] || '📌';

    const eventBody = {
      summary: `${icon} ${activity.title || activity.summary || 'Actividad'}`,
      description: `Actividad de Bit CRM (${activity.type})\n\nVer en el CRM: ${PUBLIC_APP_URL}/activities`,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 30 },
          { method: 'email', minutes: 60 },
        ],
      },
    };

    let eventLink;
    if (activity.google_event_id) {
      try {
        const { data } = await calendar.events.update({ calendarId: 'primary', eventId: activity.google_event_id, requestBody: eventBody });
        eventLink = data.htmlLink;
      } catch (err) {
        const { data } = await calendar.events.insert({ calendarId: 'primary', requestBody: eventBody });
        await supabase.from('activities').update({ google_event_id: data.id }).eq('id', activity.id);
        eventLink = data.htmlLink;
      }
    } else {
      const { data } = await calendar.events.insert({ calendarId: 'primary', requestBody: eventBody });
      await supabase.from('activities').update({ google_event_id: data.id }).eq('id', activity.id);
      eventLink = data.htmlLink;
    }

    return { ok: true, eventLink, connectedEmail: email };
  } catch (err) {
    console.error('Error sincronizando actividad con Google Calendar:', activity.id, err.message);
    return { ok: false, reason: err.message };
  }
}

module.exports = { syncTaskToCalendar, deleteTaskFromCalendar, syncActivityToCalendar };
