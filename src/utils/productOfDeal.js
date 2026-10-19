// Producto «efectivo» de un trato, para las métricas por producto.
//  1) Si el trato tiene product_line (lo que se eligió del catálogo), ese manda.
//  2) Si no, y el embudo ya dice la línea (Bit WiFi, Bit Music, Neomedia, Signage), se toma del embudo.
//  3) Si no, «Sin especificar».
// Compatibilidad: el valor viejo «Bit Signage / Neomedia» mezclaba dos líneas distintas. Si el embudo es
// Neomedia se cuenta como Neomedia; si no se puede saber, se muestra aparte para que se reclasifique.
const LEGACY = 'Bit Signage / Neomedia';
const LEGACY_LABEL = 'Bit Signage / Neomedia (sin separar)';

function productOfDeal(deal) {
  const line = String(deal?.product_line || '').trim();
  const pipeline = String(deal?.pipelines?.name || deal?.pipeline_name || '');
  if (line === LEGACY) return /neomedia/i.test(pipeline) ? 'Neomedia' : LEGACY_LABEL;
  if (line) return line;
  if (/wifi/i.test(pipeline)) return 'Bit WiFi';
  if (/music/i.test(pipeline)) return 'Bit Music';
  if (/neomedia/i.test(pipeline)) return 'Neomedia';
  if (/signage|cartel/i.test(pipeline)) return 'Bit Signage';
  return 'Sin especificar';
}

// Agrupa tratos ganados y abiertos por producto (mismo formato que hardware_insights).
function buildProductInsights(deals, toUsd) {
  const stats = {};
  (deals || []).forEach((d) => {
    if (d.status !== 'ganado' && d.status !== 'abierto') return;
    const key = productOfDeal(d);
    if (!stats[key]) stats[key] = { won_value_usd: 0, won_count: 0, pipeline_value_usd: 0, pipeline_count: 0 };
    const usd = toUsd(d.value, d.currency);
    if (d.status === 'ganado') { stats[key].won_value_usd += usd; stats[key].won_count += 1; }
    else { stats[key].pipeline_value_usd += usd; stats[key].pipeline_count += 1; }
  });
  return Object.entries(stats)
    .map(([name, s]) => ({
      name,
      won_value_usd: Math.round(s.won_value_usd),
      won_count: s.won_count,
      pipeline_value_usd: Math.round(s.pipeline_value_usd),
      pipeline_count: s.pipeline_count,
    }))
    .sort((a, b) => b.won_value_usd - a.won_value_usd || b.pipeline_value_usd - a.pipeline_value_usd);
}

module.exports = { productOfDeal, buildProductInsights, LEGACY, LEGACY_LABEL };
