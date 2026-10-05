// PostgREST (Supabase) corta cualquier consulta en 1000 filas sin avisar. Con ~3.300 empresas,
// miles de contactos y >1.000 tratos, varias pantallas y procesos estaban trabajando con datos
// incompletos (métricas que no suman todo, importaciones que no "ven" contactos que ya existen
// y los vuelven a crear duplicados, etc.). Estas utilidades traen TODAS las filas.

const PAGE = 1000;

// Recorre un query builder de Supabase por páginas. El builder se puede re-ejecutar:
// .range() reemplaza offset/limit en cada vuelta. Se agrega un desempate estable (por defecto
// 'id') para que las páginas no repitan ni salten filas que comparten el mismo valor de orden.
async function fetchAll(builder, tiebreak = ['id']) {
  for (const col of tiebreak) builder = builder.order(col, { ascending: true });
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await builder.range(from, from + PAGE - 1);
    if (error) return { data: null, error };
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return { data: rows, error: null };
}

// .in('col', ids) con cientos de UUIDs arma una URL demasiado larga y la consulta falla.
// Parte la lista en bloques, sin duplicados, y une los resultados.
async function selectIn(buildQuery, column, ids, { tiebreak = ['id'], chunkSize = 150 } = {}) {
  const unique = [...new Set((ids || []).filter((v) => v != null && v !== ''))];
  const rows = [];
  for (let i = 0; i < unique.length; i += chunkSize) {
    const { data, error } = await fetchAll(buildQuery().in(column, unique.slice(i, i + chunkSize)), tiebreak);
    if (error) return { data: null, error };
    rows.push(...data);
  }
  return { data: rows, error: null };
}

module.exports = { fetchAll, selectIn };
