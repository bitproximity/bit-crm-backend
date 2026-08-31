const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { syncActivityToCalendar, getCalendarClientForUser } = require('../utils/googleCalendarSync');
const { sendEmail } = require('../utils/email');

const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || 'https://crm.bitproximity.com';

const router = express.Router();
router.use(requireAuth);

// GET /api/activities?status=pendiente|vencida|completada&mine=true — vista global tipo "Acciones" de Pipedrive
router.get('/', async (req, res) => {
  const { status, mine } = req.query;

  let query = supabase
    .from('activities')
    .select(`
      *,
      team_members(full_name)
    `)
    .order('due_date', { ascending: true, nullsFirst: false });

  if (mine === 'true') query = query.eq('author_id', req.teamMember.id);

  if (status === 'completada') query = query.eq('done', true);
  else if (status === 'vencida') query = query.eq('done', false).lt('due_date', new Date().toISOString());
  else if (status === 'pendiente') query = query.eq('done', false).gte('due_date', new Date().toISOString());

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Resuelve el nombre de la entidad relacionada (contacto/empresa/deal) para mostrarla en la tabla
  const byType = { contact: [], company: [], deal: [] };
  data.forEach((a) => byType[a.entity_type]?.push(a.entity_id));

  const labelTables = {
    contact: { table: 'contacts', label: (r) => `${r.first_name} ${r.last_name || ''}`.trim() },
    company: { table: 'companies', label: (r) => r.name },
    deal: { table: 'deals', label: (r) => r.title },
  };

  const labelMaps = {};
  for (const [type, ids] of Object.entries(byType)) {
    if (!ids.length) continue;
    const { table, label } = labelTables[type];
    const { data: rows } = await supabase.from(table).select('*').in('id', ids);
    labelMaps[type] = Object.fromEntries((rows || []).map((r) => [r.id, label(r)]));
  }

  const enriched = data.map((a) => ({
    ...a,
    entity_label: labelMaps[a.entity_type]?.[a.entity_id] || null,
  }));

  res.json(enriched);
});

// GET /api/activities/for/:entity_type/:entity_id
router.get('/for/:entity_type/:entity_id', async (req, res) => {
  const { entity_type, entity_id } = req.params;
  const { data, error } = await supabase
    .from('activities')
    .select('*, team_members(full_name)')
    .eq('entity_type', entity_type)
    .eq('entity_id', entity_id)
    .order('occurred_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/activities  { entity_type, entity_id, type, summary, occurred_at? }
router.post('/', async (req, res) => {
  const payload = { ...req.body, author_id: req.teamMember.id };
  const { data, error } = await supabase.from('activities').insert(payload).select().single();
  if (error) return res.status(400).json({ error: error.message });

  // Fire-and-forget: si falla el calendario, la actividad ya quedó guardada de todas formas.
  const calendarResult = await syncActivityToCalendar(data);
  res.status(201).json({ ...data, calendar_sync: calendarResult });

  // Notificación por correo a quien fue mencionado con @Nombre en una nota — no bloquea
  // la respuesta. Mismo patrón que las menciones en comentarios de tareas.
  if (data.type === 'nota' && data.summary) {
    notifyMentions(data.summary, req.teamMember, data);
  }
});

async function notifyMentions(body, author, activity) {
  const { data: team } = await supabase.from('team_members').select('id, full_name, email').eq('active', true);
  const mentioned = (team || []).filter(
    (m) => m.id !== author.id && body.toLowerCase().includes(`@${m.full_name.toLowerCase()}`)
  );
  if (mentioned.length === 0) return;

  let entityLabel = '';
  let entityUrl = `${PUBLIC_APP_URL}/`;
  if (activity.entity_type === 'deal') {
    const { data: deal } = await supabase.from('deals').select('title').eq('id', activity.entity_id).maybeSingle();
    entityLabel = deal?.title ? `el trato "${deal.title}"` : 'un trato';
    entityUrl = `${PUBLIC_APP_URL}/deals/${activity.entity_id}`;
  } else if (activity.entity_type === 'contact') {
    entityLabel = 'un contacto';
  } else if (activity.entity_type === 'company') {
    entityLabel = 'una empresa';
  }

  for (const member of mentioned) {
    sendEmail({
      to: member.email,
      subject: `${author.full_name} te mencionó en ${entityLabel}`,
      html: `
        <div style="font-family: sans-serif; color: #1a1a2e; max-width: 480px;">
          <p><strong>${author.full_name}</strong> te mencionó en una nota de ${entityLabel}:</p>
          <div style="background:#f4f4f8; border-radius:8px; padding:12px 16px; margin: 12px 0;">${body}</div>
          <a href="${entityUrl}" style="color:#8500FF;">Ver en Bit CRM →</a>
        </div>
      `,
    }).catch(() => {});
  }
}

// PATCH /api/activities/:id  { done?, title?, due_date?, summary? }
router.patch('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('activities')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  const calendarResult = await syncActivityToCalendar(data);
  res.json({ ...data, calendar_sync: calendarResult });
});

// Inserta un array grande en lotes (evita timeouts/payloads gigantes en Supabase)
async function batchInsert(table, rows, chunkSize = 500) {
  const inserted = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { data, error } = await supabase.from(table).insert(chunk).select();
    if (error) throw new Error(error.message);
    inserted.push(...(data || []));
  }
  return inserted;
}

// POST /api/activities/import  { activities: [{ title, type, due_date, contact_name, deal_title, done }] }
router.post('/import', async (req, res) => {
  const { activities } = req.body;
  if (!Array.isArray(activities) || activities.length === 0) {
    return res.status(400).json({ error: 'Falta el array de actividades' });
  }

  const results = { created: 0, errors: [] };
  const validTypes = ['llamada', 'email', 'reunion', 'nota', 'whatsapp', 'tarea'];

  // Trae de una sola vez todos los deals y contactos existentes, para
  // enlazar por nombre sin consultar la base fila por fila.
  const [{ data: allDeals }, { data: allContacts }] = await Promise.all([
    supabase.from('deals').select('id, title'),
    supabase.from('contacts').select('id, first_name'),
  ]);

  const dealByTitle = new Map((allDeals || []).map((d) => [d.title.toLowerCase().trim(), d.id]));
  const contactByFirstName = new Map((allContacts || []).map((c) => [c.first_name.toLowerCase().trim(), c.id]));

  const activitiesToInsert = [];
  activities.forEach((a, i) => {
    if (!a.title) {
      results.errors.push({ row: i + 1, error: 'Falta el asunto' });
      return;
    }

    let entity_type = null;
    let entity_id = null;

    if (a.deal_title) {
      const dealId = dealByTitle.get(a.deal_title.toLowerCase().trim());
      if (dealId) { entity_type = 'deal'; entity_id = dealId; }
    }
    if (!entity_id && a.contact_name) {
      const contactId = contactByFirstName.get(a.contact_name.split(' ')[0].toLowerCase().trim());
      if (contactId) { entity_type = 'contact'; entity_id = contactId; }
    }

    const type = validTypes.includes(a.type?.toLowerCase()) ? a.type.toLowerCase() : 'tarea';

    activitiesToInsert.push({
      title: a.title,
      summary: a.title,
      type,
      entity_type,
      entity_id,
      due_date: a.due_date || null,
      occurred_at: a.due_date || new Date().toISOString(),
      done: a.done === 'true' || a.done === '1' || a.done === true,
      author_id: req.teamMember.id,
    });
  });

  if (activitiesToInsert.length > 0) {
    try {
      const created = await batchInsert('activities', activitiesToInsert);
      results.created = created.length;
    } catch (err) {
      results.errors.push({ row: 0, error: `Error insertando actividades: ${err.message}` });
    }
  }

  res.json(results);
});

// DELETE /api/activities/:id
router.delete('/:id', async (req, res) => {
  const { data: activity } = await supabase.from('activities').select('*').eq('id', req.params.id).maybeSingle();
  if (!activity) return res.status(404).json({ error: 'Actividad no encontrada.' });

  if (activity.google_event_id && activity.author_id) {
    const conn = await getCalendarClientForUser(activity.author_id);
    if (conn) await conn.calendar.events.delete({ calendarId: 'primary', eventId: activity.google_event_id }).catch(() => {});
  }

  const { error } = await supabase.from('activities').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
});

module.exports = router;
