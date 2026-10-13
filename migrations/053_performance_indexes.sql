-- 053 — Índices de rendimiento (OPCIONAL, idempotente y seguro de repetir).
-- Todos con IF NOT EXISTS: si ya existe uno equivalente, no pasa nada. Las columnas están confirmadas
-- por las consultas del backend. La base del CRM es chica (~60 MB), así que se crean en segundos.
-- Hoy la base NO es el cuello de botella (el tiempo se va en viajes de red entre regiones); estos
-- índices son preventivos para cuando crezca el volumen de tratos.

-- Lista de tratos: filtra por estado y ordena por updated_at desc, id (paginación estable)
create index if not exists idx_deals_status_updated on deals (status, updated_at desc, id);
-- Dashboard / métricas: ganados y perdidos del mes
create index if not exists idx_deals_status_closed on deals (status, closed_at) where status in ('ganado', 'perdido');
-- Vista de pipeline: tratos abiertos de un embudo
create index if not exists idx_deals_pipeline_status on deals (pipeline_id, status);
-- Ranking de productos del Dashboard (join de líneas de producto con tratos ganados)
create index if not exists idx_deal_line_items_deal on deal_line_items (deal_id);
create index if not exists idx_deal_line_items_product on deal_line_items (product_id);
-- Cada validación de sesión busca al usuario por auth_user_id
create index if not exists idx_team_members_auth_user on team_members (auth_user_id);
-- Cada validación de API key (MCP / herramientas) busca por el hash
create index if not exists idx_mcp_api_keys_hash on mcp_api_keys (key_hash) where revoked_at is null;
-- Listas: contactos de una etiqueta
create index if not exists idx_taggables_tag_entity on taggables (tag_id, entity_type);

-- Actualiza las estadísticas para que el planificador use los índices desde el primer momento
analyze deals;
analyze deal_line_items;
analyze taggables;
