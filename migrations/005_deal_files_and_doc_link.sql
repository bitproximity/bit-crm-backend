-- Vincular Documentos (Notion-like) a un trato específico
alter table documents add column if not exists deal_id uuid references deals(id) on delete set null;
create index if not exists idx_documents_deal on documents(deal_id);

-- Archivos adjuntos a un trato (metadata; el binario vive en Supabase Storage)
create table if not exists deal_files (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid references deals(id) on delete cascade,
  file_name text not null,
  file_path text not null,
  file_size int,
  mime_type text,
  uploaded_by uuid references team_members(id) on delete set null,
  created_at timestamptz default now()
);

create index if not exists idx_deal_files_deal on deal_files(deal_id);

-- Bucket de Storage para los archivos (público de solo-lectura por URL; las rutas usan UUIDs no adivinables)
insert into storage.buckets (id, name, public)
values ('deal-files', 'deal-files', true)
on conflict (id) do nothing;
