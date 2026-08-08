-- Índices de rendimiento para las tablas originales (nunca los tuvieron).
-- Con 17k+ contactos y 1300+ deals ya importados, esto es lo que más está
-- frenando la interfaz: cada filtro/búsqueda escaneaba la tabla completa.

-- Deals: filtros por pipeline, etapa, empresa, contacto, dueño, estado
create index if not exists idx_deals_pipeline on deals(pipeline_id);
create index if not exists idx_deals_stage on deals(stage_id);
create index if not exists idx_deals_company on deals(company_id);
create index if not exists idx_deals_contact on deals(contact_id);
create index if not exists idx_deals_owner on deals(owner_id);
create index if not exists idx_deals_status on deals(status);
create index if not exists idx_deals_created_at on deals(created_at);

-- Tasks: filtros por proyecto, asignado, estado, jerarquía de subtareas
create index if not exists idx_tasks_project on tasks(project_id);
create index if not exists idx_tasks_assignee on tasks(assignee_id);
create index if not exists idx_tasks_status on tasks(status);
create index if not exists idx_tasks_parent on tasks(parent_task_id);
create index if not exists idx_tasks_due_date on tasks(due_date);

-- Contactos y empresas: FK + búsqueda
create index if not exists idx_contacts_company on contacts(company_id);
create index if not exists idx_contacts_owner on contacts(owner_id);
create index if not exists idx_contacts_email on contacts(email);

-- Actividades y etiquetas: lookup polimórfico (entity_type, entity_id) que se usa en TODOS lados
create index if not exists idx_activities_entity on activities(entity_type, entity_id);
create index if not exists idx_taggables_entity on taggables(entity_type, entity_id);

-- Búsqueda "contiene texto" (ilike '%termino%'): un índice normal no ayuda ahí,
-- se necesita pg_trgm + índice GIN para que sea rápido de verdad.
create extension if not exists pg_trgm;

create index if not exists idx_contacts_first_name_trgm on contacts using gin (first_name gin_trgm_ops);
create index if not exists idx_contacts_last_name_trgm on contacts using gin (last_name gin_trgm_ops);
create index if not exists idx_contacts_email_trgm on contacts using gin (email gin_trgm_ops);
create index if not exists idx_companies_name_trgm on companies using gin (name gin_trgm_ops);
create index if not exists idx_deals_title_trgm on deals using gin (title gin_trgm_ops);
