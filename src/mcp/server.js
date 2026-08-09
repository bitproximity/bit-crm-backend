const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');
const supabase = require('../config/supabase');

// ── Helpers compartidos ──────────────────────────────────────────────

function textResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

async function resolvePipelineAndStage(pipelineName, stageName) {
  const { data: pipeline } = await supabase.from('pipelines').select('*, pipeline_stages(*)').ilike('name', pipelineName).maybeSingle();
  if (!pipeline) return { error: `No encontré un embudo llamado "${pipelineName}". Usa bitcrm_list_pipelines para ver los nombres exactos.` };
  let stage = null;
  if (stageName) {
    stage = pipeline.pipeline_stages.find((s) => s.name.toLowerCase() === stageName.toLowerCase());
    if (!stage) return { error: `El embudo "${pipeline.name}" no tiene una etapa llamada "${stageName}".` };
  } else {
    stage = [...pipeline.pipeline_stages].sort((a, b) => a.position - b.position)[0];
  }
  return { pipeline, stage };
}

async function resolveOrCreateContact(name, email, phone) {
  if (!name && !email) return null;
  if (email) {
    const { data: existing } = await supabase.from('contacts').select('id').eq('email', email).maybeSingle();
    if (existing) return existing.id;
  }
  const parts = (name || email).trim().split(/\s+/);
  const { data: created } = await supabase
    .from('contacts')
    .insert({ first_name: parts[0], last_name: parts.slice(1).join(' ') || null, email: email || null, phone: phone || null })
    .select('id')
    .single();
  return created?.id || null;
}

async function resolveOrCreateCompany(name) {
  if (!name) return null;
  const { data: existing } = await supabase.from('companies').select('id').ilike('name', name).maybeSingle();
  if (existing) return existing.id;
  const { data: created } = await supabase.from('companies').insert({ name }).select('id').single();
  return created?.id || null;
}

// ── Construye un McpServer nuevo por request, con las herramientas ──
// atadas al equipo autenticado (teamMember) vía closure. Esto es lo que
// recomienda el SDK para transporte HTTP sin estado (stateless).
function buildServer(teamMember) {
  const server = new McpServer({ name: 'bit-crm-mcp-server', version: '1.0.0' });

  // ─── DEALS ───
  server.registerTool(
    'bitcrm_list_deals',
    {
      title: 'Listar tratos del pipeline',
      description: 'Lista deals (tratos) de Bit CRM, opcionalmente filtrados por embudo, estado o texto de búsqueda en el título. Devuelve id, título, valor, moneda, estado y etapa de cada uno.',
      inputSchema: {
        pipeline_name: z.string().optional().describe('Nombre exacto o parcial del embudo (ej. "Bit Colombia")'),
        status: z.enum(['abierto', 'ganado', 'perdido']).optional().describe('Filtrar por estado del trato'),
        search: z.string().optional().describe('Texto a buscar en el título del trato'),
        limit: z.number().int().min(1).max(100).default(30).describe('Máximo de resultados'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ pipeline_name, status, search, limit }) => {
      let query = supabase
        .from('deals')
        .select('id, title, value, currency, status, created_at, pipelines(name), pipeline_stages(name), companies(name), contacts(first_name,last_name)')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (status) query = query.eq('status', status);
      if (search) query = query.ilike('title', `%${search}%`);
      if (pipeline_name) {
        const { data: pipeline } = await supabase.from('pipelines').select('id').ilike('name', pipeline_name).maybeSingle();
        if (!pipeline) return errorResult(`No encontré un embudo llamado "${pipeline_name}".`);
        query = query.eq('pipeline_id', pipeline.id);
      }
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      return textResult({
        count: data.length,
        deals: data.map((d) => ({
          id: d.id, title: d.title, value: d.value, currency: d.currency, status: d.status,
          pipeline: d.pipelines?.name, stage: d.pipeline_stages?.name, company: d.companies?.name,
          contact: d.contacts ? `${d.contacts.first_name} ${d.contacts.last_name || ''}`.trim() : null,
        })),
      });
    }
  );

  server.registerTool(
    'bitcrm_get_deal',
    {
      title: 'Ver detalle de un trato',
      description: 'Obtiene el detalle completo de un deal por su ID: valor, etapa, contacto, empresa, tareas asociadas y notas recientes.',
      inputSchema: { deal_id: z.string().uuid().describe('ID del trato') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ deal_id }) => {
      const [{ data: deal, error }, { data: activities }] = await Promise.all([
        supabase.from('deals').select('*, pipelines(name), pipeline_stages(name), companies(name), contacts(first_name,last_name,email,phone)').eq('id', deal_id).single(),
        supabase.from('activities').select('type, summary, occurred_at').eq('entity_type', 'deal').eq('entity_id', deal_id).order('occurred_at', { ascending: false }).limit(5),
      ]);
      if (error) return errorResult('Trato no encontrado.');
      return textResult({ ...deal, recent_activity: activities || [] });
    }
  );

  server.registerTool(
    'bitcrm_create_deal',
    {
      title: 'Crear un trato nuevo',
      description: 'Crea un deal nuevo en un embudo de Bit CRM. Si el contacto o la empresa no existen, los crea automáticamente por nombre.',
      inputSchema: {
        title: z.string().min(1).describe('Título del trato'),
        pipeline_name: z.string().describe('Nombre del embudo donde crear el trato (ej. "Bit Colombia")'),
        stage_name: z.string().optional().describe('Nombre de la etapa; si se omite usa la primera etapa del embudo'),
        value: z.number().min(0).default(0).describe('Valor del trato'),
        currency: z.enum(['USD', 'COP', 'MXN', 'PYG', 'DOP', 'EUR']).default('USD'),
        contact_name: z.string().optional().describe('Nombre del contacto (se crea si no existe)'),
        contact_email: z.string().email().optional(),
        company_name: z.string().optional().describe('Nombre de la empresa (se crea si no existe)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title, pipeline_name, stage_name, value, currency, contact_name, contact_email, company_name }) => {
      const resolved = await resolvePipelineAndStage(pipeline_name, stage_name);
      if (resolved.error) return errorResult(resolved.error);

      const [contactId, companyId] = await Promise.all([
        resolveOrCreateContact(contact_name, contact_email, null),
        resolveOrCreateCompany(company_name),
      ]);

      const { data: deal, error } = await supabase
        .from('deals')
        .insert({
          title, value, currency, status: 'abierto',
          pipeline_id: resolved.pipeline.id, stage_id: resolved.stage.id,
          contact_id: contactId, company_id: companyId, owner_id: teamMember.id,
        })
        .select()
        .single();
      if (error) return errorResult(error.message);
      return textResult({ created: true, deal_id: deal.id, title: deal.title, pipeline: resolved.pipeline.name, stage: resolved.stage.name });
    }
  );

  server.registerTool(
    'bitcrm_update_deal_stage',
    {
      title: 'Mover un trato de etapa, o marcarlo ganado/perdido',
      description: 'Cambia la etapa de un deal dentro de su embudo actual, o lo marca como ganado o perdido.',
      inputSchema: {
        deal_id: z.string().uuid(),
        stage_name: z.string().optional().describe('Nueva etapa dentro del mismo embudo'),
        outcome: z.enum(['ganado', 'perdido']).optional().describe('Marcar el trato como ganado o perdido'),
        lost_reason: z.string().optional().describe('Motivo, solo si outcome=perdido'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ deal_id, stage_name, outcome, lost_reason }) => {
      if (outcome === 'ganado') {
        const { error } = await supabase.from('deals').update({ status: 'ganado', closed_at: new Date().toISOString() }).eq('id', deal_id);
        if (error) return errorResult(error.message);
        return textResult({ updated: true, deal_id, status: 'ganado' });
      }
      if (outcome === 'perdido') {
        const { error } = await supabase.from('deals').update({ status: 'perdido', closed_at: new Date().toISOString(), lost_reason: lost_reason || null }).eq('id', deal_id);
        if (error) return errorResult(error.message);
        return textResult({ updated: true, deal_id, status: 'perdido' });
      }
      if (stage_name) {
        const { data: deal } = await supabase.from('deals').select('pipeline_id').eq('id', deal_id).single();
        if (!deal) return errorResult('Trato no encontrado.');
        const { data: stage } = await supabase.from('pipeline_stages').select('id').eq('pipeline_id', deal.pipeline_id).ilike('name', stage_name).maybeSingle();
        if (!stage) return errorResult(`No encontré la etapa "${stage_name}" en el embudo de este trato.`);
        const { error } = await supabase.from('deals').update({ stage_id: stage.id }).eq('id', deal_id);
        if (error) return errorResult(error.message);
        await supabase.from('deal_stage_history').insert({ deal_id, to_stage_id: stage.id, changed_by: teamMember.id });
        return textResult({ updated: true, deal_id, stage: stage_name });
      }
      return errorResult('Debes indicar stage_name u outcome.');
    }
  );

  // ─── CONTACTOS Y EMPRESAS ───
  server.registerTool(
    'bitcrm_list_contacts',
    {
      title: 'Buscar contactos',
      description: 'Busca contactos por nombre, apellido o correo. Devuelve id, nombre, correo, teléfono y empresa asociada.',
      inputSchema: {
        search: z.string().optional().describe('Texto a buscar en nombre/apellido/correo'),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ search, limit }) => {
      let query = supabase.from('contacts').select('id, first_name, last_name, email, phone, companies(name)').order('created_at', { ascending: false }).limit(limit);
      if (search) query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      return textResult({ count: data.length, contacts: data.map((c) => ({ id: c.id, name: `${c.first_name} ${c.last_name || ''}`.trim(), email: c.email, phone: c.phone, company: c.companies?.name })) });
    }
  );

  server.registerTool(
    'bitcrm_create_contact',
    {
      title: 'Crear un contacto',
      description: 'Crea una persona de contacto nueva en Bit CRM, opcionalmente vinculada a una empresa (se crea si no existe).',
      inputSchema: {
        first_name: z.string().min(1),
        last_name: z.string().optional(),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        company_name: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ first_name, last_name, email, phone, company_name }) => {
      const companyId = await resolveOrCreateCompany(company_name);
      const { data, error } = await supabase
        .from('contacts')
        .insert({ first_name, last_name: last_name || null, email: email || null, phone: phone || null, company_id: companyId, owner_id: teamMember.id })
        .select()
        .single();
      if (error) return errorResult(error.message);
      return textResult({ created: true, contact_id: data.id });
    }
  );

  server.registerTool(
    'bitcrm_list_companies',
    {
      title: 'Buscar empresas',
      description: 'Busca empresas por nombre. Devuelve id, nombre, industria y país.',
      inputSchema: { search: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ search, limit }) => {
      let query = supabase.from('companies').select('id, name, industry, country').order('created_at', { ascending: false }).limit(limit);
      if (search) query = query.ilike('name', `%${search}%`);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      return textResult({ count: data.length, companies: data });
    }
  );

  // ─── TAREAS ───
  server.registerTool(
    'bitcrm_list_tasks',
    {
      title: 'Listar tareas',
      description: 'Lista tareas de Bit CRM. Sin filtros, devuelve las tareas asignadas a quien hace la consulta. Se puede filtrar por proyecto, estado o solo las vencidas.',
      inputSchema: {
        project_id: z.string().uuid().optional(),
        status: z.enum(['pendiente', 'en_progreso', 'bloqueada', 'completada']).optional(),
        only_mine: z.boolean().default(true).describe('Si es true (default), solo tareas asignadas a quien consulta'),
        overdue_only: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(30),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, status, only_mine, overdue_only, limit }) => {
      let query = supabase.from('tasks').select('id, title, status, priority, due_date, projects(name)').order('due_date', { ascending: true, nullsFirst: false }).limit(limit);
      if (project_id) query = query.eq('project_id', project_id);
      if (status) query = query.eq('status', status);
      if (only_mine) query = query.eq('assignee_id', teamMember.id);
      if (overdue_only) query = query.lt('due_date', new Date().toISOString()).neq('status', 'completada');
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      return textResult({ count: data.length, tasks: data.map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, due_date: t.due_date, project: t.projects?.name })) });
    }
  );

  server.registerTool(
    'bitcrm_create_task',
    {
      title: 'Crear una tarea',
      description: 'Crea una tarea nueva, opcionalmente dentro de un proyecto y asignada a alguien del equipo.',
      inputSchema: {
        title: z.string().min(1),
        project_id: z.string().uuid().optional(),
        due_date: z.string().optional().describe('Fecha límite en formato ISO (ej. 2026-08-20)'),
        priority: z.enum(['baja', 'media', 'alta', 'urgente']).default('media'),
        assign_to_me: z.boolean().default(false).describe('Si es true, se asigna a quien crea la tarea'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title, project_id, due_date, priority, assign_to_me }) => {
      const { data, error } = await supabase
        .from('tasks')
        .insert({
          title, project_id: project_id || null, due_date: due_date || null, priority,
          status: 'pendiente', assignee_id: assign_to_me ? teamMember.id : null, created_by: teamMember.id,
        })
        .select()
        .single();
      if (error) return errorResult(error.message);
      return textResult({ created: true, task_id: data.id });
    }
  );

  server.registerTool(
    'bitcrm_update_task',
    {
      title: 'Actualizar una tarea',
      description: 'Cambia el estado, la prioridad o la fecha límite de una tarea existente.',
      inputSchema: {
        task_id: z.string().uuid(),
        status: z.enum(['pendiente', 'en_progreso', 'bloqueada', 'completada']).optional(),
        priority: z.enum(['baja', 'media', 'alta', 'urgente']).optional(),
        due_date: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ task_id, status, priority, due_date }) => {
      const update = {};
      if (status) update.status = status;
      if (priority) update.priority = priority;
      if (due_date) update.due_date = due_date;
      if (Object.keys(update).length === 0) return errorResult('No indicaste ningún campo para actualizar.');
      const { error } = await supabase.from('tasks').update(update).eq('id', task_id);
      if (error) return errorResult(error.message);
      return textResult({ updated: true, task_id, ...update });
    }
  );

  // ─── PROYECTOS ───
  server.registerTool(
    'bitcrm_list_projects',
    {
      title: 'Listar proyectos',
      description: 'Lista los proyectos de Bit CRM con su estado y espacio.',
      inputSchema: {
        space_id: z.string().uuid().optional(),
        status: z.enum(['activo', 'pausado', 'completado', 'cancelado']).optional(),
        limit: z.number().int().min(1).max(100).default(30),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ space_id, status, limit }) => {
      let query = supabase.from('projects').select('id, name, status, spaces(name)').order('created_at', { ascending: false }).limit(limit);
      if (space_id) query = query.eq('space_id', space_id);
      if (status) query = query.eq('status', status);
      const { data, error } = await query;
      if (error) return errorResult(error.message);
      return textResult({ count: data.length, projects: data.map((p) => ({ id: p.id, name: p.name, status: p.status, space: p.spaces?.name })) });
    }
  );

  // ─── MÉTRICAS ───
  server.registerTool(
    'bitcrm_get_metrics_summary',
    {
      title: 'Resumen de métricas del CRM',
      description: 'Devuelve el resumen general: tratos abiertos, ganados este mes, tareas vencidas, tareas propias pendientes y valor total del pipeline abierto en USD.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
      const [{ count: openDeals }, { count: wonThisMonth }, { count: overdueTasks }, { data: valueRows }, { data: rates }] = await Promise.all([
        supabase.from('deals').select('*', { count: 'exact', head: true }).eq('status', 'abierto'),
        supabase.from('deals').select('*', { count: 'exact', head: true }).eq('status', 'ganado').gte('closed_at', firstDay),
        supabase.from('tasks').select('*', { count: 'exact', head: true }).lt('due_date', new Date().toISOString()).neq('status', 'completada'),
        supabase.from('deals').select('value, currency').eq('status', 'abierto'),
        supabase.from('exchange_rates').select('*'),
      ]);
      const rateMap = Object.fromEntries((rates || []).map((r) => [r.currency, Number(r.rate_to_usd)]));
      const openPipelineValueUsd = (valueRows || []).reduce((sum, d) => sum + Number(d.value || 0) * (rateMap[d.currency] ?? 1), 0);
      return textResult({
        open_deals: openDeals || 0,
        won_this_month: wonThisMonth || 0,
        overdue_tasks: overdueTasks || 0,
        open_pipeline_value_usd: Math.round(openPipelineValueUsd),
      });
    }
  );

  server.registerTool(
    'bitcrm_list_pipelines',
    {
      title: 'Listar embudos y sus etapas',
      description: 'Lista todos los embudos (pipelines) de Bit CRM con el nombre exacto de sus etapas — útil antes de crear o mover un trato.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const { data, error } = await supabase.from('pipelines').select('name, pipeline_stages(name, position)').order('name');
      if (error) return errorResult(error.message);
      return textResult({
        pipelines: data.map((p) => ({ name: p.name, stages: p.pipeline_stages.sort((a, b) => a.position - b.position).map((s) => s.name) })),
      });
    }
  );

  return server;
}

module.exports = { buildServer };
