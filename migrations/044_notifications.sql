-- Notificaciones dentro de la app: te asignan una tarea, te reasignan un trato, un
-- trato que eres dueño se marca ganado/perdido, o te mencionan (@nombre) en una nota.
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references team_members(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  entity_type text,
  entity_id uuid,
  link text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_recipient_idx on notifications (recipient_id, read, created_at desc);
