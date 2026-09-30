-- Permisos por rol, configurables desde Configuración sin tocar código. "resource" es el
-- nombre de la sección (por ahora solo 'automations'; agregar otra en el futuro es una
-- fila nueva, no una migración nueva). admin siempre tiene acceso total — no está en esta
-- tabla, se resuelve como excepción fija en el middleware.
create table if not exists role_permissions (
  id uuid primary key default gen_random_uuid(),
  role text not null,
  resource text not null,
  can_view boolean not null default false,
  can_manage boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (role, resource)
);

-- Arranca igual de restringido que estaba antes (solo admin) — nadie pierde ni gana acceso
-- con esta migración, Mario decide desde Configuración a partir de acá.
insert into role_permissions (role, resource, can_view, can_manage) values
  ('operaciones', 'automations', false, false),
  ('outbound', 'automations', false, false),
  ('wifi_partner', 'automations', false, false),
  ('ventas', 'automations', false, false)
on conflict (role, resource) do nothing;
