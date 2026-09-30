-- Formularios públicos de captura de leads: cada uno cae directo a un pipeline+etapa
-- elegidos, con dueño opcional, sin que nadie tenga que cargarlo a mano.
create table if not exists lead_forms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  pipeline_id uuid not null references pipelines(id),
  stage_id uuid not null references pipeline_stages(id),
  owner_id uuid references team_members(id),
  active boolean not null default true,
  submissions_count integer not null default 0,
  created_by uuid references team_members(id),
  created_at timestamptz not null default now()
);
