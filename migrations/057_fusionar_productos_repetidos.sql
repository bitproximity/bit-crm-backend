-- 057 — Fusionar productos repetidos del catálogo
-- Dónde correrlo: Supabase → proyecto «CRM Bit» → SQL Editor → pegar TODO → Run.
--
-- Decisión (la tomaste tú): te quedas con
--     Bit Signage · Cartelería Digital (Neomedia) · WhatsApp Marketing
-- y los otros tres se FUSIONAN en esos y se ARCHIVAN (no se borran):
--     «Bit Signage (Digital Signage)» → Bit Signage
--     «Neomedia»                      → Cartelería Digital (Neomedia)
--     «WhatsApp»                      → WhatsApp Marketing
--
-- Qué hace, en este orden:
--   1) Guarda una COPIA de todo lo que va a cambiar (tabla fusion_productos_respaldo).
--   2) Pasa a los productos elegidos: las líneas de productos de los tratos, las líneas de las facturas
--      y el «Producto» de los tratos. Los precios y cantidades NO se tocan (cada línea guarda el suyo).
--   3) Archiva los 3 productos viejos: dejan de aparecer al crear tratos; siguen existiendo.
--   4) Muestra una tabla de verificación: «referencias que quedan» debe ser 0 en los tres.
-- Seguro de repetir: lo que ya se fusionó no se vuelve a tocar.

-- Pares viejo → nuevo, con sus ids (comparación sin distinguir mayúsculas)
create temp table if not exists _pares as
select v.viejo, v.nuevo, pv.id as viejo_id, pn.id as nuevo_id, pn.name as nuevo_nombre
from (values
  ('Bit Signage (Digital Signage)', 'Bit Signage'),
  ('Neomedia',                      'Cartelería Digital (Neomedia)'),
  ('WhatsApp',                      'WhatsApp Marketing')
) as v(viejo, nuevo)
left join products pv on lower(pv.name) = lower(v.viejo)
left join products pn on lower(pn.name) = lower(v.nuevo);

-- 1) Copia de seguridad
create table if not exists fusion_productos_respaldo (
  tabla text, fila_id uuid, valor_anterior text, respaldado_el timestamptz default now()
);
insert into fusion_productos_respaldo (tabla, fila_id, valor_anterior)
select 'deal_line_items', li.id, li.product_id::text
from deal_line_items li join _pares p on li.product_id = p.viejo_id
where p.nuevo_id is not null and p.viejo_id <> p.nuevo_id;
insert into fusion_productos_respaldo (tabla, fila_id, valor_anterior)
select 'invoice_line_items', li.id, li.product_id::text
from invoice_line_items li join _pares p on li.product_id = p.viejo_id
where p.nuevo_id is not null and p.viejo_id <> p.nuevo_id;
insert into fusion_productos_respaldo (tabla, fila_id, valor_anterior)
select 'deals', d.id, d.product_line
from deals d join _pares p on lower(d.product_line) = lower(p.viejo)
where p.nuevo_id is not null;
insert into fusion_productos_respaldo (tabla, fila_id, valor_anterior)
select 'products', pr.id, 'activo'
from products pr join _pares p on pr.id = p.viejo_id
where p.nuevo_id is not null and p.viejo_id <> p.nuevo_id and pr.active is not false;

-- 2) Fusionar
update deal_line_items li set product_id = p.nuevo_id
from _pares p
where li.product_id = p.viejo_id and p.nuevo_id is not null and p.viejo_id <> p.nuevo_id;

update invoice_line_items li set product_id = p.nuevo_id
from _pares p
where li.product_id = p.viejo_id and p.nuevo_id is not null and p.viejo_id <> p.nuevo_id;

update deals d set product_line = p.nuevo_nombre
from _pares p
where lower(d.product_line) = lower(p.viejo) and p.nuevo_id is not null;

-- 3) Archivar los viejos
update products pr set active = false
from _pares p
where pr.id = p.viejo_id and p.nuevo_id is not null and p.viejo_id <> p.nuevo_id;

-- 4) Verificación
select p.viejo as producto_viejo,
       case when p.viejo_id is null then 'no existe' when (select active from products where id = p.viejo_id) is false then 'archivado' else 'ACTIVO (revisar)' end as estado_viejo,
       (select count(*) from deal_line_items where product_id = p.viejo_id)
       + (select count(*) from invoice_line_items where product_id = p.viejo_id)
       + (select count(*) from deals where lower(product_line) = lower(p.viejo)) as referencias_que_quedan,
       p.nuevo as se_fusionó_en,
       case when p.nuevo_id is null then 'NO EXISTE: no se fusionó' else 'ok' end as nuevo
from _pares p
order by p.viejo;

drop table if exists _pares;

-- ─────────────────────────────────────────────────────────────────────────────
-- REVERSA (solo si quisieras deshacerlo; NO correr junto con lo de arriba):
-- update deal_line_items d set product_id = b.valor_anterior::uuid from fusion_productos_respaldo b where b.tabla = 'deal_line_items' and b.fila_id = d.id;
-- update invoice_line_items d set product_id = b.valor_anterior::uuid from fusion_productos_respaldo b where b.tabla = 'invoice_line_items' and b.fila_id = d.id;
-- update deals d set product_line = b.valor_anterior from fusion_productos_respaldo b where b.tabla = 'deals' and b.fila_id = d.id;
-- update products p set active = true from fusion_productos_respaldo b where b.tabla = 'products' and b.fila_id = p.id;
