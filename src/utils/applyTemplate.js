const supabase = require('../config/supabase');

// Crea en un proyecto las tareas de una plantilla (task_templates + task_template_items).
// La fecha de cada tarea = fecha base + days_offset del ítem. Devuelve las tareas creadas.
async function applyTemplateToProject({ templateId, projectId, baseDate = new Date(), createdBy = null }) {
  const { data: template, error } = await supabase
    .from('task_templates')
    .select('id, name, task_template_items(*)')
    .eq('id', templateId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!template) { const e = new Error('Plantilla no encontrada.'); e.status = 404; throw e; }

  const items = (template.task_template_items || []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  if (!items.length) return { template, tasks: [] };

  const rows = items.map((item, i) => {
    const due = new Date(baseDate);
    due.setDate(due.getDate() + (Number(item.days_offset) || 0));
    const row = {
      project_id: projectId,
      title: item.title,
      description: item.description || null,
      due_date: due.toISOString(),
      position: item.position ?? i,
      status: 'pendiente',
    };
    if (item.assignee_id) row.assignee_id = item.assignee_id;
    if (createdBy) row.created_by = createdBy;
    return row;
  });
  const { data: tasks, error: insErr } = await supabase.from('tasks').insert(rows).select();
  if (insErr) throw new Error(insErr.message);
  return { template, tasks };
}

module.exports = { applyTemplateToProject };
