-- Archivos de Google Drive vinculados a un trato, contacto o empresa — no se copia el
-- archivo, solo se guarda la referencia (id de Drive + metadata liviana) para mostrarlo y
-- abrirlo con un clic. El contenido real sigue viviendo en Drive.
create table if not exists drive_files (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  team_member_id uuid references team_members(id),
  drive_file_id text not null,
  name text,
  mime_type text,
  icon_link text,
  web_view_link text,
  linked_at timestamptz default now()
);
create index if not exists drive_files_entity_idx on drive_files (entity_type, entity_id);
