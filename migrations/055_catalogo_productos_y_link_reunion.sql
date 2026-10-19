-- 055 — Catálogo de productos + link de reunión + Signage/Neomedia separados
-- Dónde correrlo: Supabase → proyecto «CRM Bit» → SQL Editor → pegar TODO → Run.
-- Seguro de repetir: todo usa IF NOT EXISTS / WHERE NOT EXISTS; no borra nada.
--
-- 1) Link de la reunión en tareas y actividades (se envía al evento de Google Calendar).
-- 2) Productos del catálogo: Bit Music, Bit WiFi, Bit Signage, Neomedia y los 4 servicios nuevos
--    (Email Marketing, WhatsApp Marketing, Loyalty, SMS). Solo se crean los que NO existan ya por nombre
--    (sin distinguir mayúsculas), y quedan en precio 0 para que los ajustes en Productos.
-- 3) Tratos viejos con «Bit Signage / Neomedia» que están en un embudo Neomedia pasan a «Neomedia».
--    Los de otros embudos NO se tocan (no hay forma de saber cuál de las dos líneas eran): al final se
--    cuenta cuántos quedan para que los reclasifiques a mano si quieres.

-- 1) Link de reunión
alter table tasks add column if not exists meeting_url text;
alter table activities add column if not exists meeting_url text;

-- 2) Productos del catálogo
insert into products (name, type, price, currency, billing_frequency, active)
select v.name, 'servicio', 0, 'USD', 'mensual', true
from (values
  ('Bit Music'), ('Bit WiFi'), ('Bit Signage'), ('Neomedia'),
  ('Email Marketing'), ('WhatsApp Marketing'), ('Loyalty'), ('SMS')
) as v(name)
where not exists (select 1 from products p where lower(p.name) = lower(v.name));

-- 3) Signage / Neomedia separados (solo los que están en un embudo Neomedia)
update deals
set product_line = 'Neomedia'
where product_line = 'Bit Signage / Neomedia'
  and pipeline_id in (select id from pipelines where name ilike '%neomedia%');

-- 4) Verificación (debe verse así: 8 productos, 1 y 1 columnas, y los pendientes que te queden)
select 'Productos del catálogo (de los 8)' as concepto,
       count(*)::int as cantidad
from products
where lower(name) in ('bit music', 'bit wifi', 'bit signage', 'neomedia', 'email marketing', 'whatsapp marketing', 'loyalty', 'sms')
union all
select 'Columna meeting_url en tareas (1 = lista)', count(*)::int
from information_schema.columns where table_name = 'tasks' and column_name = 'meeting_url'
union all
select 'Columna meeting_url en actividades (1 = lista)', count(*)::int
from information_schema.columns where table_name = 'activities' and column_name = 'meeting_url'
union all
select 'Tratos «Bit Signage / Neomedia» por separar a mano', count(*)::int
from deals where product_line = 'Bit Signage / Neomedia';

-- ─────────────────────────────────────────────────────────────────────────────
-- OPCIONAL (correr aparte): ver cuáles tratos quedaron con el valor viejo para decidir uno a uno
-- select d.id, d.title, p.name as embudo
-- from deals d left join pipelines p on p.id = d.pipeline_id
-- where d.product_line = 'Bit Signage / Neomedia' order by p.name, d.title;
