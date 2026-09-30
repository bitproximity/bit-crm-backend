-- Meta mensual de reuniones agendadas por vendedor (Bit Prospect) — opcionalmente por
-- cliente. client_name usa '' (no NULL) para la cuota "general": en un unique constraint,
-- Postgres trata cada NULL como distinto de cualquier otro NULL (no chocan entre sí), así
-- que dos cuotas generales de la misma persona/mes se insertarían como filas separadas en
-- vez de pisarse. '' sí se compara como un valor normal, así que el upsert funciona.
create table if not exists sales_quotas (
  id uuid primary key default gen_random_uuid(),
  team_member_id uuid not null references team_members(id) on delete cascade,
  month text not null, -- 'YYYY-MM'
  target_meetings integer not null,
  client_name text not null default '',
  created_by uuid references team_members(id),
  created_at timestamptz not null default now(),
  unique (team_member_id, month, client_name)
);
