-- Espacios (tipo ClickUp): agrupan proyectos
create table if not exists spaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text default '#8500FF',
  icon text,
  position int default 0,
  created_at timestamptz default now()
);

alter table projects add column if not exists space_id uuid references spaces(id) on delete set null;

-- Documentos (tipo Notion): páginas anidadas con contenido en markdown
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'Sin título',
  content text default '',
  parent_id uuid references documents(id) on delete cascade,
  space_id uuid references spaces(id) on delete set null,
  created_by uuid references team_members(id) on delete set null,
  position int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_documents_parent on documents(parent_id);
create index if not exists idx_documents_space on documents(space_id);
create index if not exists idx_projects_space on projects(space_id);
