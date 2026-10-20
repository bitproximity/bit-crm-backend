-- 053 — Índices de rendimiento para Bit CRM (OPCIONAL, seguro de repetir)
-- Dónde correrlo: Supabase → proyecto «CRM Bit» → SQL Editor → pegar todo → Run.
-- (Es el proyecto con tablas deals / contacts / companies. NO el proyecto «Bit Proximity».)
--
-- Seguridad:
--  · Todo con IF NOT EXISTS: si ya existe, no hace nada. Se puede correr las veces que quieras.
--  · Solo AGREGA índices; no modifica ni borra datos ni tablas.
--  · La base es chica (~60 MB): cada índice se crea en menos de un segundo.
--  · Revisado contra tus migraciones: se omiten índices que ya existen (productos del trato,
--    listas/etiquetas) para no crear duplicados.
--
-- Honestidad sobre el efecto: con ~700 tratos abiertos la base NO es lenta por falta de índices
-- (el tiempo se va en la capacidad del plan Free/NANO). Esto es preventivo, para cuando crezca el
-- volumen, y el de facturas acompaña a la sincronización que ya quedó optimizada.

-- Lista de tratos: filtra por estado y ordena por updated_at desc, id (paginación estable)
create index if not exists idx_deals_status_updated on deals (status, updated_at desc, id);

-- Dashboard y métricas: tratos ganados/perdidos por fecha de cierre
create index if not exists idx_deals_status_closed on deals (status, closed_at) where status in ('ganado', 'perdido');

-- Vista de pipeline: tratos abiertos de un embudo
create index if not exists idx_deals_pipeline_status on deals (pipeline_id, status);

-- Sincronización de facturas (Stripe / Alegra / Facturero Móvil): lectura de lo ya importado por fuente
create index if not exists idx_invoices_external on invoices (external_source, external_id);

-- Actualiza las estadísticas para que PostgreSQL use los índices desde el primer momento
analyze deals;
analyze invoices;

-- Confirmación: debe devolver 4 filas
select tablename as tabla, indexname as indice
from pg_indexes
where schemaname = 'public'
  and indexname in ('idx_deals_status_updated', 'idx_deals_status_closed', 'idx_deals_pipeline_status', 'idx_invoices_external')
order by tablename, indexname;

-- ─────────────────────────────────────────────────────────────────────────────
-- REVERSA (solo si algún día quisieras deshacerlo; NO correr junto con lo de arriba):
-- drop index if exists idx_deals_status_updated;
-- drop index if exists idx_deals_status_closed;
-- drop index if exists idx_deals_pipeline_status;
-- drop index if exists idx_invoices_external;
