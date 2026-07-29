const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/dashboard — resumen para la vista principal
router.get('/', async (req, res) => {
  const [
    { count: openDeals },
    { count: wonThisMonth },
    { count: overdueTasks },
    { count: myOpenTasks },
    { data: valueRows },
  ] = await Promise.all([
    supabase.from('deals').select('*', { count: 'exact', head: true }).eq('status', 'abierto'),
    supabase
      .from('deals')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'ganado')
      .gte('closed_at', firstDayOfMonth()),
    supabase
      .from('tasks')
      .select('*', { count: 'exact', head: true })
      .lt('due_date', new Date().toISOString())
      .neq('status', 'completada'),
    supabase
      .from('tasks')
      .select('*', { count: 'exact', head: true })
      .eq('assignee_id', req.teamMember.id)
      .neq('status', 'completada'),
    supabase.from('deals').select('value').eq('status', 'abierto'),
  ]);

  const openPipelineValue = (valueRows || []).reduce((sum, d) => sum + Number(d.value || 0), 0);

  res.json({
    open_deals: openDeals || 0,
    won_this_month: wonThisMonth || 0,
    overdue_tasks: overdueTasks || 0,
    my_open_tasks: myOpenTasks || 0,
    open_pipeline_value: openPipelineValue,
  });
});

function firstDayOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

module.exports = router;
