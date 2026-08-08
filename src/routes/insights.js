const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/insights/funnel?pipeline_id=
// Para cada etapa: cuántos deals llegaron a esa etapa o más adelante
// (incluye ganados/perdidos según en qué etapa quedaron), sobre el total.
router.get('/funnel', async (req, res) => {
  const { pipeline_id } = req.query;
  if (!pipeline_id) return res.status(400).json({ error: 'Falta pipeline_id' });

  const [{ data: stages }, { data: deals }] = await Promise.all([
    supabase
      .from('pipeline_stages')
      .select('*')
      .eq('pipeline_id', pipeline_id)
      .order('position'),
    supabase.from('deals').select('id, stage_id, status').eq('pipeline_id', pipeline_id),
  ]);

  const positionByStage = Object.fromEntries(stages.map((s) => [s.id, s.position]));
  const total = deals.length;

  const funnel = stages.map((stage) => {
    const reached = deals.filter((d) => {
      const dealPos = positionByStage[d.stage_id];
      return dealPos !== undefined && dealPos >= stage.position;
    }).length;

    return {
      stage_id: stage.id,
      stage: stage.name,
      position: stage.position,
      deals_reached: reached,
      pct_of_total: total ? Math.round((reached / total) * 100) : 0,
    };
  });

  res.json({ total_deals: total, funnel });
});

// GET /api/insights/velocity?pipeline_id= — tiempo promedio (días) que un deal pasa en cada etapa
router.get('/velocity', async (req, res) => {
  const { pipeline_id } = req.query;
  if (!pipeline_id) return res.status(400).json({ error: 'Falta pipeline_id' });

  const { data: stages } = await supabase
    .from('pipeline_stages')
    .select('*')
    .eq('pipeline_id', pipeline_id)
    .order('position');

  const { data: deals } = await supabase
    .from('deals')
    .select('id, stage_id, status, created_at, closed_at')
    .eq('pipeline_id', pipeline_id);

  const dealIds = deals.map((d) => d.id);
  const { data: history } = await supabase
    .from('deal_stage_history')
    .select('*')
    .in('deal_id', dealIds.length ? dealIds : ['00000000-0000-0000-0000-000000000000'])
    .order('changed_at', { ascending: true });

  const historyByDeal = {};
  (history || []).forEach((h) => {
    historyByDeal[h.deal_id] = historyByDeal[h.deal_id] || [];
    historyByDeal[h.deal_id].push(h);
  });

  // Acumula duración (ms) por etapa en base a la línea de tiempo real de cada deal
  const durationsByStage = {}; // stage_id -> [ms, ms, ...]

  deals.forEach((deal) => {
    const dealHistory = historyByDeal[deal.id] || [];
    const endTime = deal.status === 'abierto' ? Date.now() : new Date(deal.closed_at || deal.created_at).getTime();

    let currentStage = dealHistory.length ? dealHistory[0].from_stage_id || deal.stage_id : deal.stage_id;
    let segmentStart = new Date(deal.created_at).getTime();

    dealHistory.forEach((h) => {
      const changeTime = new Date(h.changed_at).getTime();
      durationsByStage[currentStage] = durationsByStage[currentStage] || [];
      durationsByStage[currentStage].push(changeTime - segmentStart);
      currentStage = h.to_stage_id;
      segmentStart = changeTime;
    });

    // Último tramo: desde el último cambio (o creación, si nunca se movió) hasta ahora/cierre
    durationsByStage[currentStage] = durationsByStage[currentStage] || [];
    durationsByStage[currentStage].push(Math.max(endTime - segmentStart, 0));
  });

  const DAY_MS = 1000 * 60 * 60 * 24;
  const velocity = stages.map((stage) => {
    const durations = durationsByStage[stage.id] || [];
    const avgMs = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    return {
      stage_id: stage.id,
      stage: stage.name,
      avg_days: Math.round((avgMs / DAY_MS) * 10) / 10,
      sample_size: durations.length,
    };
  });

  res.json({ velocity });
});

// GET /api/insights/audit/:entity_type/:entity_id — historial de una entidad puntual
router.get('/audit/:entity_type/:entity_id', async (req, res) => {
  const { entity_type, entity_id } = req.params;
  const { data, error } = await supabase
    .from('audit_log')
    .select('*, team_members(full_name)')
    .eq('entity_type', entity_type)
    .eq('entity_id', entity_id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/insights/feed?limit=50 — actividad reciente global, con nombre de la entidad resuelto
router.get('/feed', async (req, res) => {
  const limit = Number(req.query.limit) || 50;

  const { data: rows, error } = await supabase
    .from('audit_log')
    .select('*, team_members(full_name)')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: error.message });

  const byType = { contact: [], company: [], deal: [], task: [], project: [] };
  rows.forEach((r) => byType[r.entity_type]?.push(r.entity_id));

  const labelTables = {
    contact: { table: 'contacts', label: (r) => `${r.first_name} ${r.last_name || ''}`.trim() },
    company: { table: 'companies', label: (r) => r.name },
    deal: { table: 'deals', label: (r) => r.title },
    task: { table: 'tasks', label: (r) => r.title },
    project: { table: 'projects', label: (r) => r.name },
  };

  const labelMaps = {};
  for (const [type, ids] of Object.entries(byType)) {
    if (!ids.length) continue;
    const { table, label } = labelTables[type];
    const { data } = await supabase.from(table).select('*').in('id', ids);
    labelMaps[type] = Object.fromEntries((data || []).map((row) => [row.id, label(row)]));
  }

  const enriched = rows.map((r) => ({
    ...r,
    entity_label: labelMaps[r.entity_type]?.[r.entity_id] || '(eliminado)',
  }));

  res.json(enriched);
});

// GET /api/insights/dashboard?year=2026 — panorama tipo "Avances" de Pipedrive
router.get('/dashboard', async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const yearStart = `${year}-01-01T00:00:00.000Z`;
  const yearEnd = `${year + 1}-01-01T00:00:00.000Z`;
  const prevYearStart = `${year - 1}-01-01T00:00:00.000Z`;
  const prevYearEnd = `${year}-01-01T00:00:00.000Z`;

  const { data: pipelines } = await supabase.from('pipelines').select('id, name');
  const pipelineNameById = Object.fromEntries((pipelines || []).map((p) => [p.id, p.name]));

  const { data: deals, error } = await supabase
    .from('deals')
    .select('id, value, currency, pipeline_id, status, created_at, closed_at, lost_reason');

  if (error) return res.status(500).json({ error: error.message });

  const monthKey = (iso) => iso.slice(0, 7); // YYYY-MM
  const monthLabel = (key) => {
    const [, m] = key.split('-');
    return ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][Number(m) - 1];
  };
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);

  // ── Insights AI Report: valor de deals creados por mes, apilado por pipeline ──
  const createdByMonth = {};
  months.forEach((m) => { createdByMonth[m] = {}; });
  (deals || []).forEach((d) => {
    if (d.created_at < yearStart || d.created_at >= yearEnd) return;
    const key = monthKey(d.created_at);
    if (!createdByMonth[key]) return;
    const pName = pipelineNameById[d.pipeline_id] || 'Sin pipeline';
    createdByMonth[key][pName] = (createdByMonth[key][pName] || 0) + Number(d.value || 0);
  });
  const deals_by_month = months.map((m) => ({
    month: m,
    label: monthLabel(m),
    total: Object.values(createdByMonth[m]).reduce((a, b) => a + b, 0),
    by_pipeline: createdByMonth[m],
  }));

  // ── Deal duration: promedio de días entre creación y cierre (ganado/perdido) ──
  const closedDeals = (deals || []).filter((d) => d.status !== 'abierto' && d.closed_at);
  const avgDurationDays = closedDeals.length
    ? Math.round(
        (closedDeals.reduce((sum, d) => sum + (new Date(d.closed_at) - new Date(d.created_at)), 0) /
          closedDeals.length) /
          86400000
      )
    : 0;

  // ── Deals lost by reasons ──
  const lostDeals = (deals || []).filter((d) => d.status === 'perdido');
  const reasonMap = {};
  lostDeals.forEach((d) => {
    const reason = d.lost_reason?.trim() || '(sin motivo)';
    reasonMap[reason] = (reasonMap[reason] || 0) + 1;
  });
  const deals_lost_by_reason = Object.entries(reasonMap)
    .map(([reason, count]) => ({ reason, count, pct: lostDeals.length ? Math.round((count / lostDeals.length) * 100) : 0 }))
    .sort((a, b) => b.count - a.count);

  // ── Average value of won deals: este año vs año anterior ──
  const wonThisYear = (deals || []).filter((d) => d.status === 'ganado' && d.closed_at >= yearStart && d.closed_at < yearEnd);
  const wonPrevYear = (deals || []).filter((d) => d.status === 'ganado' && d.closed_at >= prevYearStart && d.closed_at < prevYearEnd);
  const avg = (arr) => (arr.length ? arr.reduce((sum, d) => sum + Number(d.value || 0), 0) / arr.length : 0);
  const avgThisYear = avg(wonThisYear);
  const avgPrevYear = avg(wonPrevYear);
  const pctChange = avgPrevYear ? Math.round(((avgThisYear - avgPrevYear) / avgPrevYear) * 1000) / 10 : null;

  // ── Deals won over time: valor de deals ganados por mes de cierre ──
  const wonByMonth = {};
  months.forEach((m) => { wonByMonth[m] = 0; });
  wonThisYear.forEach((d) => {
    const key = monthKey(d.closed_at);
    if (wonByMonth[key] !== undefined) wonByMonth[key] += Number(d.value || 0);
  });
  const deals_won_by_month = months.map((m) => ({ month: m, label: monthLabel(m), value: wonByMonth[m] }));

  res.json({
    year,
    pipelines: pipelines || [],
    deals_by_month,
    deal_duration_avg_days: avgDurationDays,
    deals_lost_by_reason,
    lost_total: lostDeals.length,
    won_avg_value: { current: Math.round(avgThisYear), previous: Math.round(avgPrevYear), pct_change: pctChange, count: wonThisYear.length },
    deals_won_by_month,
  });
});

module.exports = router;
