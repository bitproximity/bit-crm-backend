const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { requirePage } = require('../middleware/pagePermissions');
const { resolveDealCountry } = require('../utils/pipelineCountry');

const router = express.Router();
router.use(requireAuth);
router.use(requirePage('metricas'));

// Mismo criterio que metrics.js: wifi_partner solo ve Bit WiFi. Se fuerza pipeline_id acá
// para las 3 rutas de este archivo (funnel, la de línea 50, y dashboard) en un solo lugar
// en vez de repetirlo en cada una.
let bitWifiPipelineIdCache = null;
async function getBitWifiPipelineId() {
  if (bitWifiPipelineIdCache) return bitWifiPipelineIdCache;
  const { data } = await supabase.from('pipelines').select('id').eq('name', 'Bit WiFi').maybeSingle();
  bitWifiPipelineIdCache = data?.id || null;
  return bitWifiPipelineIdCache;
}
router.use(async (req, res, next) => {
  if (req.teamMember?.role !== 'wifi_partner') return next();
  const bitWifiId = await getBitWifiPipelineId();
  if (bitWifiId) req.query.pipeline_id = bitWifiId;
  next();
});

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

  const byType = { contact: [], company: [], deal: [], task: [], project: [], b2b_record: [] };
  rows.forEach((r) => byType[r.entity_type]?.push(r.entity_id));

  const labelTables = {
    contact: { table: 'contacts', label: (r) => `${r.first_name} ${r.last_name || ''}`.trim() },
    company: { table: 'companies', label: (r) => r.name },
    deal: { table: 'deals', label: (r) => r.title },
    task: { table: 'tasks', label: (r) => r.title },
    project: { table: 'projects', label: (r) => r.name },
    // Registros de Bit Prospect — antes no dejaban rastro en el feed de actividad.
    b2b_record: { table: 'b2b_records', label: (r) => r.target_company },
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
  const { pipeline_id } = req.query;
  const yearStart = `${year}-01-01T00:00:00.000Z`;
  const yearEnd = `${year + 1}-01-01T00:00:00.000Z`;
  const prevYearStart = `${year - 1}-01-01T00:00:00.000Z`;
  const prevYearEnd = `${year}-01-01T00:00:00.000Z`;

  const { data: pipelines } = await supabase.from('pipelines').select('id, name');
  const pipelineNameById = Object.fromEntries((pipelines || []).map((p) => [p.id, p.name]));
  // Si hay un pipeline_id filtrado, la lista de pipelines que se le devuelve al frontend
  // (para la leyenda de colores del gráfico) debe reflejar solo ese filtro — antes siempre
  // devolvía los 12 pipelines completos aunque el gráfico solo tuviera datos de uno, lo que
  // hacía que la leyenda mostrara 12 colores sin sentido cuando ya se había filtrado a 1.
  const visiblePipelines = pipeline_id ? (pipelines || []).filter((p) => p.id === pipeline_id) : pipelines || [];

  let dealsQuery = supabase
    .from('deals')
    .select('id, value, currency, pipeline_id, company_id, status, probability, billing_frequency, hardware_type, created_at, closed_at, lost_reason, facturacion, companies(country), pipelines(name)');
  if (pipeline_id) dealsQuery = dealsQuery.eq('pipeline_id', pipeline_id);

  const [{ data: deals, error }, { data: rates }] = await Promise.all([
    dealsQuery,
    supabase.from('exchange_rates').select('*'),
  ]);

  if (error) return res.status(500).json({ error: error.message });

  // FIX critico de moneda: las 3 secciones de abajo (tratos por mes, valor promedio de
  // ganados, ganados en el tiempo) sumaban d.value crudo de distintas monedas (USD, COP,
  // MXN, PYG...) sin convertir — mismo bug ya arreglado antes en Pipeline por etapa/Empresa,
  // pero acá nunca se había tocado. Un solo trato grande en COP o PYG podía inflar un mes
  // o el promedio muy por encima de la realidad.
  const rateMap = Object.fromEntries((rates || []).map((r) => [r.currency, Number(r.rate_to_usd)]));
  const toUsd = (value, currency) => Number(value || 0) * (rateMap[currency] ?? 1);

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
    createdByMonth[key][pName] = (createdByMonth[key][pName] || 0) + toUsd(d.value, d.currency);
  });
  const deals_by_month = months.map((m) => ({
    month: m,
    label: monthLabel(m),
    total: Math.round(Object.values(createdByMonth[m]).reduce((a, b) => a + b, 0)),
    by_pipeline: Object.fromEntries(Object.entries(createdByMonth[m]).map(([k, v]) => [k, Math.round(v)])),
    is_current_month: m === monthKey(new Date().toISOString()),
  }));

  // ── Deal duration: promedio de días entre creación y cierre (ganado/perdido) ──
  const closedDeals = (deals || []).filter((d) => d.status !== 'abierto' && d.closed_at);
  const avgDays = (arr) =>
    arr.length
      ? Math.round((arr.reduce((sum, d) => sum + (new Date(d.closed_at) - new Date(d.created_at)), 0) / arr.length) / 86400000)
      : 0;
  const avgDurationDays = avgDays(closedDeals);
  // Se agrega el desglose ganados vs. perdidos: saber si los tratos perdidos tardan más o
  // menos en cerrarse que los ganados es un dato accionable (¿se está tardando demasiado en
  // descartar tratos que no van a avanzar?), y antes solo existía el promedio combinado.
  const avgDurationDaysWon = avgDays(closedDeals.filter((d) => d.status === 'ganado'));
  const avgDurationDaysLost = avgDays(closedDeals.filter((d) => d.status === 'perdido'));

  // ── Deals lost by reasons ──
  // FIX: antes agrupaba por el texto exacto del motivo, así que "No tiene presupuesto",
  // "no tiene presupuesto" y "no tienen presupuesto" contaban como 3 motivos distintos en
  // vez de uno solo — fragmentaba el gráfico de torta sin necesidad. Se normaliza espacios/
  // mayúsculas para agrupar, pero se muestra con la primera letra en mayúscula.
  const lostDeals = (deals || []).filter((d) => d.status === 'perdido');
  const reasonMap = {};
  lostDeals.forEach((d) => {
    const raw = d.lost_reason?.trim().replace(/\s+/g, ' ') || '(sin motivo)';
    const key = raw.toLowerCase();
    if (!reasonMap[key]) reasonMap[key] = { label: raw.charAt(0).toUpperCase() + raw.slice(1), count: 0 };
    reasonMap[key].count += 1;
  });
  const deals_lost_by_reason = Object.values(reasonMap)
    .map(({ label, count }) => ({ reason: label, count, pct: lostDeals.length ? Math.round((count / lostDeals.length) * 100) : 0 }))
    .sort((a, b) => b.count - a.count);

  // ── Average value of won deals: este año vs año anterior ──
  const wonThisYear = (deals || []).filter((d) => d.status === 'ganado' && d.closed_at >= yearStart && d.closed_at < yearEnd);
  const wonPrevYear = (deals || []).filter((d) => d.status === 'ganado' && d.closed_at >= prevYearStart && d.closed_at < prevYearEnd);
  const avg = (arr) => (arr.length ? arr.reduce((sum, d) => sum + toUsd(d.value, d.currency), 0) / arr.length : 0);
  const avgThisYear = avg(wonThisYear);
  const avgPrevYear = avg(wonPrevYear);
  const pctChange = avgPrevYear ? Math.round(((avgThisYear - avgPrevYear) / avgPrevYear) * 1000) / 10 : null;

  // ── País líder en ventas (ingresos reales de tratos ganados, todo el historial) ──
  // Llena el hueco que quedaba junto al valor promedio de tratos ganados.
  // Si la empresa no tiene país cargado (pasa mucho con clientes chicos de WiFi Marketing,
  // cargados rápido sin llenar ese campo), se infiere del pipeline cuando el pipeline es
  // de un país puntual (Bit Colombia, Bit México, etc.) — pipelines multi-país como
  // "WiFi Marketing" u "Omnicanalidad" no permiten inferir nada, ahí se queda "Sin especificar".
  const allWonDeals = (deals || []).filter((d) => d.status === 'ganado');
  const salesByCountry = {};
  allWonDeals.forEach((d) => {
    const country = resolveDealCountry(d.companies?.country, pipelineNameById[d.pipeline_id]);
    salesByCountry[country] = (salesByCountry[country] || 0) + toUsd(d.value, d.currency);
  });
  const sales_by_country = Object.entries(salesByCountry)
    .map(([name, value_usd]) => ({ name, value_usd: Math.round(value_usd) }))
    .sort((a, b) => b.value_usd - a.value_usd);

  // ── Ventas por facturación (campo explícito del trato, no inferido) ──
  // A diferencia de "sales_by_country" de arriba (que adivina el país por la empresa o el
  // pipeline), este usa el campo "Facturación" que se carga a mano en cada trato — más
  // confiable porque es la entidad real que factura, no una aproximación.
  const salesByFacturacion = {};
  allWonDeals.forEach((d) => {
    const key = d.facturacion?.trim() || 'Sin especificar';
    salesByFacturacion[key] = (salesByFacturacion[key] || 0) + toUsd(d.value, d.currency);
  });
  const sales_by_facturacion = Object.entries(salesByFacturacion)
    .map(([name, value_usd]) => ({ name, value_usd: Math.round(value_usd) }))
    .sort((a, b) => b.value_usd - a.value_usd);

  // ── MRR / ARR ──
  // Se basa en el campo "Frecuencia de facturación" del TRATO mismo (no del producto) —
  // más directo: quien cierra el trato sabe si el contrato se factura mensual o anual, sin
  // depender de que cada producto del catálogo esté bien clasificado.
  // mensual: el valor del trato tal cual. anual: valor del trato /12. único o sin marcar:
  // no cuenta para MRR — antes un trato SIN marcar caía por defecto en "mensual", lo que
  // inflaba el número con tratos únicos (venta de hardware, setup) y con tratos importados
  // que nunca se revisaron uno por uno. Ahora "sin marcar" se trata igual que "único": no
  // cuenta, hasta que alguien lo etiquete a mano con la frecuencia real.
  // OJO: no hay seguimiento de cancelaciones/churn todavía, así que "MRR ganado" es en
  // realidad la suma de todo lo vendido como recurrente históricamente, asumiendo que sigue
  // activo — no un MRR verificado mes a mes.
  const monthlyValue = (d) => {
    const freq = d.billing_frequency;
    if (freq !== 'mensual' && freq !== 'anual') return 0;
    const raw = toUsd(d.value, d.currency);
    return freq === 'anual' ? raw / 12 : raw;
  };

  let mrrWon = 0, mrrPipeline = 0, mrrPipelineWeighted = 0;
  (deals || []).forEach((d) => {
    const m = monthlyValue(d);
    if (d.status === 'ganado') mrrWon += m;
    else if (d.status === 'abierto') {
      mrrPipeline += m;
      mrrPipelineWeighted += m * (Number(d.probability || 0) / 100);
    }
  });

  const mrr_arr = {
    mrr_won: Math.round(mrrWon),
    arr_won: Math.round(mrrWon * 12),
    mrr_pipeline: Math.round(mrrPipeline),
    arr_pipeline: Math.round(mrrPipeline * 12),
    mrr_pipeline_weighted: Math.round(mrrPipelineWeighted),
    arr_pipeline_weighted: Math.round(mrrPipelineWeighted * 12),
  };

  // ── MRR/ARR por país de facturación + pipeline asociado ──
  // Cruza el campo Facturación del trato (país/entidad que factura, NO el país de la
  // empresa) con el pipeline al que pertenece — mismo criterio de "cuenta si tiene
  // frecuencia de facturación explícita" que el MRR/ARR general de arriba.
  const mrrByCountryPipeline = {};
  (deals || []).forEach((d) => {
    if (d.status !== 'ganado' && d.status !== 'abierto') return;
    const m = monthlyValue(d);
    if (m <= 0) return;
    const country = d.facturacion?.trim() || 'Sin especificar';
    const pipeline = d.pipelines?.name || 'Sin pipeline';
    const key = `${country}|||${pipeline}`;
    if (!mrrByCountryPipeline[key]) {
      mrrByCountryPipeline[key] = { country, pipeline, mrr_won: 0, arr_won: 0, mrr_pipeline: 0, arr_pipeline: 0 };
    }
    if (d.status === 'ganado') {
      mrrByCountryPipeline[key].mrr_won += m;
    } else {
      mrrByCountryPipeline[key].mrr_pipeline += m;
    }
  });
  const mrr_by_country_pipeline = Object.values(mrrByCountryPipeline)
    .map((r) => ({
      country: r.country,
      pipeline: r.pipeline,
      mrr_won: Math.round(r.mrr_won),
      arr_won: Math.round(r.mrr_won * 12),
      mrr_pipeline: Math.round(r.mrr_pipeline),
      arr_pipeline: Math.round(r.mrr_pipeline * 12),
    }))
    .sort((a, b) => b.mrr_won - a.mrr_won);

  // ── Hardware: ventas ganadas y pipeline abierto, agrupado por tipo de hardware ──
  // Usa deals.hardware_type (campo del trato, opciones según pipeline — ver
  // hardwareOptionsForPipeline en el frontend). "Sin especificar" agrupa los tratos que
  // no lo tienen cargado — con un pipeline puntual elegido (ej. Bit WiFi) esto da el
  // ranking real de qué marca de equipo se vende más; con "Todos los pipelines" mezcla
  // hardware de líneas de negocio distintas, útil solo para ver el total general.
  const hardwareStats = {};
  (deals || []).forEach((d) => {
    if (d.status !== 'ganado' && d.status !== 'abierto') return;
    const key = d.hardware_type?.trim() || 'Sin especificar';
    if (!hardwareStats[key]) hardwareStats[key] = { won_value_usd: 0, won_count: 0, pipeline_value_usd: 0, pipeline_count: 0 };
    const usd = toUsd(d.value, d.currency);
    if (d.status === 'ganado') {
      hardwareStats[key].won_value_usd += usd;
      hardwareStats[key].won_count += 1;
    } else {
      hardwareStats[key].pipeline_value_usd += usd;
      hardwareStats[key].pipeline_count += 1;
    }
  });
  const hardware_insights = Object.entries(hardwareStats)
    .map(([name, s]) => ({
      name,
      won_value_usd: Math.round(s.won_value_usd),
      won_count: s.won_count,
      pipeline_value_usd: Math.round(s.pipeline_value_usd),
      pipeline_count: s.pipeline_count,
    }))
    .sort((a, b) => b.won_value_usd - a.won_value_usd);

  // ── Deals won over time: valor de deals ganados por mes de cierre ──
  const wonByMonth = {};
  months.forEach((m) => { wonByMonth[m] = 0; });
  wonThisYear.forEach((d) => {
    const key = monthKey(d.closed_at);
    if (wonByMonth[key] !== undefined) wonByMonth[key] += toUsd(d.value, d.currency);
  });
  const deals_won_by_month = months.map((m) => ({ month: m, label: monthLabel(m), value: Math.round(wonByMonth[m]), is_current_month: m === monthKey(new Date().toISOString()) }));

  res.json({
    year,
    pipelines: visiblePipelines,
    deals_by_month,
    deal_duration_avg_days: avgDurationDays,
    deal_duration_avg_days_won: avgDurationDaysWon,
    deal_duration_avg_days_lost: avgDurationDaysLost,
    deals_lost_by_reason,
    lost_total: lostDeals.length,
    won_avg_value: { current: Math.round(avgThisYear), previous: Math.round(avgPrevYear), pct_change: pctChange, count: wonThisYear.length },
    sales_by_country,
    sales_by_facturacion,
    mrr_arr,
    hardware_insights,
    mrr_by_country_pipeline,
    deals_won_by_month,
  });
});

module.exports = router;
