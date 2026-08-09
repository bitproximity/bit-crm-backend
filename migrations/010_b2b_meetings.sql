-- Módulo de Reuniones B2B: base de datos contactada + reuniones agendadas, por cliente
create table if not exists b2b_records (
  id uuid primary key default gen_random_uuid(),
  client_company_id uuid references companies(id) on delete cascade, -- la marca que paga el servicio
  target_company text not null, -- la empresa/marca contactada
  target_contact text,
  industry text,
  country text,
  contacted_at date,
  meeting_date date,
  status text not null default 'contactado', -- contactado, reunion_agendada, reunion_realizada, no_interesado, reagendar
  notes text,
  created_by uuid references team_members(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_b2b_records_client on b2b_records(client_company_id);
create index if not exists idx_b2b_records_status on b2b_records(status);
create index if not exists idx_b2b_records_industry on b2b_records(industry);
create index if not exists idx_b2b_records_country on b2b_records(country);

-- Marca qué empresas de tu CRM son clientes del servicio de Reuniones B2B (para el selector)
alter table companies add column if not exists is_b2b_client boolean default false;
