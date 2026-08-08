-- Vincular Documentos (Notion-like) también a un Proyecto específico
alter table documents add column if not exists project_id uuid references projects(id) on delete set null;
create index if not exists idx_documents_project on documents(project_id);
