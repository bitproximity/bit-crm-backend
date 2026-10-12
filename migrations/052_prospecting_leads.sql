-- Leads compartidos de Prospección B2B (opcional: solo si quieres que el equipo
-- vea el mismo estado). Correr en el SQL Editor del Supabase DEL CRM.
create table if not exists prospecting_leads (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  text
);
create index if not exists prospecting_leads_updated_idx on prospecting_leads (updated_at desc);
-- El backend usa service_role (salta RLS); esto bloquea cualquier otro acceso.
alter table prospecting_leads enable row level security;
