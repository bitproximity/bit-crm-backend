-- Archivos adjuntos a un Documento (PDF, PPT, etc.)
create table if not exists document_files (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references documents(id) on delete cascade,
  file_name text not null,
  file_path text not null,
  file_size int,
  mime_type text,
  uploaded_by uuid references team_members(id) on delete set null,
  created_at timestamptz default now()
);

create index if not exists idx_document_files_document on document_files(document_id);

-- Reutiliza el mismo patrón de bucket público que deal-files
insert into storage.buckets (id, name, public)
values ('document-files', 'document-files', true)
on conflict (id) do nothing;
