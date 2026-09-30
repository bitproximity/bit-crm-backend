-- Motor de automatizaciones: "cuando pasa X, hacer Y" sin que nadie lo dispare a mano.
-- trigger_config y action_config son JSON flexible para no necesitar una migración nueva
-- cada vez que se agregue un tipo de disparador o de acción.
--   trigger_type 'stage_changed'  -> trigger_config { to_stage_id }
--   trigger_type 'status_changed' -> trigger_config { status: 'ganado'|'perdido' }
--   trigger_type 'deal_stale'     -> trigger_config { days, pipeline_id? }
--   action_type  'create_task'    -> action_config { title, days_offset, assignee: 'owner'|<team_member_id> }
--   action_type  'notify'         -> action_config { message, recipient: 'owner'|<team_member_id> }
create table if not exists automation_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  trigger_type text not null check (trigger_type in ('stage_changed', 'status_changed', 'deal_stale')),
  trigger_config jsonb not null default '{}',
  action_type text not null check (action_type in ('create_task', 'notify')),
  action_config jsonb not null default '{}',
  active boolean not null default true,
  created_by uuid references team_members(id),
  created_at timestamptz not null default now()
);

-- Para "sin actividad hace N días": evita avisar del mismo trato todos los días una vez
-- que ya se avisó — unique(rule_id, deal_id) hace que el segundo intento no haga nada.
create table if not exists automation_triggers_log (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references automation_rules(id) on delete cascade,
  deal_id uuid not null references deals(id) on delete cascade,
  triggered_at timestamptz not null default now(),
  unique (rule_id, deal_id)
);
