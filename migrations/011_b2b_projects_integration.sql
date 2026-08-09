-- Vincula los registros de Reuniones B2B a un Proyecto (en vez de solo a una empresa suelta)
alter table b2b_records add column if not exists project_id uuid references projects(id) on delete cascade;
create index if not exists idx_b2b_records_project on b2b_records(project_id);

-- Marca qué proyectos son campañas de Reuniones B2B (para listarlos aparte)
alter table projects add column if not exists is_b2b boolean default false;

-- Link público de solo lectura para compartir el reporte con el cliente, sin login
alter table projects add column if not exists b2b_share_token uuid;
create unique index if not exists idx_projects_b2b_share_token on projects(b2b_share_token) where b2b_share_token is not null;
