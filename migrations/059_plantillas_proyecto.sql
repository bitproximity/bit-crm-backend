-- 059 · Plantillas de tareas para proyectos (27/10/2026)
-- Asegura las columnas que usa la app y deja una plantilla de onboarding lista para editar
-- (solo si todavía no hay ninguna). Idempotente.

create table if not exists task_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  created_at timestamptz default now()
);
create table if not exists task_template_items (
  id uuid primary key default gen_random_uuid(),
  template_id uuid references task_templates(id) on delete cascade,
  title text not null,
  description text,
  days_offset int default 0,
  position int default 0
);
alter table task_template_items add column if not exists description text;
alter table task_template_items add column if not exists days_offset int default 0;
alter table task_template_items add column if not exists position int default 0;
create index if not exists idx_task_template_items_template on task_template_items(template_id);

do $$
declare t uuid;
begin
  if not exists (select 1 from task_templates) then
    insert into task_templates (name, description)
    values ('Onboarding de cliente', 'Pasos estándar desde el cierre hasta la revisión de los 30 días. Edítala a tu medida.')
    returning id into t;
    insert into task_template_items (template_id, title, days_offset, position) values
      (t, 'Llamada de bienvenida y kickoff con el cliente', 1, 0),
      (t, 'Recibir datos de la marca (logo, colores, redes, accesos)', 3, 1),
      (t, 'Crear y configurar la cuenta en la plataforma', 5, 2),
      (t, 'Coordinar instalación / envío de equipos', 7, 3),
      (t, 'Capacitación al equipo del cliente', 10, 4),
      (t, 'Salida en vivo y verificación de funcionamiento', 14, 5),
      (t, 'Seguimiento: primeros resultados a los 30 días', 30, 6);
  end if;
end $$;

select t.name as plantilla, count(i.id) as tareas
from task_templates t left join task_template_items i on i.template_id = t.id
group by t.name order by t.name;
