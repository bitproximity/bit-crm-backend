-- 057 — Fusionar productos repetidos del catálogo (versión 2, sin tablas temporales)
-- Dónde correrlo: Supabase → proyecto «CRM Bit» → SQL Editor → BORRA lo que haya en el editor, pega TODO esto → Run.
--
-- Decisión (la tomaste tú): te quedas con
--     Bit Signage · Cartelería Digital (Neomedia) · WhatsApp Marketing
-- y los otros tres se FUSIONAN en esos y se ARCHIVAN (no se borran):
--     «Bit Signage (Digital Signage)» → Bit Signage
--     «Neomedia»                      → Cartelería Digital (Neomedia)
--     «WhatsApp»                      → WhatsApp Marketing
--
-- Cómo está armado (importante):
--   · Todo el cambio va dentro de UN solo bloque (el paso 2): se aplica completo o no se aplica nada,
--     sin importar cómo el editor ejecute los pasos. No usa tablas temporales.
--   · Antes de tocar cada cosa guarda una COPIA en la tabla fusion_productos_respaldo (para poder revertir).
--   · Los precios y cantidades NO se tocan: cada línea de un trato o factura guarda el suyo.
--   · Si una línea no se puede mover, se deja como está en vez de fallar, y el producto viejo NO se archiva.
--   · Si falta alguno de los productos elegidos, ese par se omite y la verificación lo dice.
--   · Seguro de repetir: lo que ya se fusionó no se vuelve a tocar.
--   · El último paso (el SELECT) solo LEE: muestra el resultado. «referencias_que_quedan» debe ser 0.

-- Paso 1: tabla de respaldo
create table if not exists fusion_productos_respaldo (
  tabla text, fila_id uuid, valor_anterior text, respaldado_el timestamptz default now()
);

-- Paso 2: la fusión (un solo bloque = todo o nada)
do $$
declare
  r record;
  li record;
begin
  for r in
    select v.viejo, v.nuevo, pv.id as viejo_id, pn.id as nuevo_id, pn.name as nuevo_nombre
    from (values
      ('Bit Signage (Digital Signage)', 'Bit Signage'),
      ('Neomedia',                      'Cartelería Digital (Neomedia)'),
      ('WhatsApp',                      'WhatsApp Marketing')
    ) as v(viejo, nuevo)
    left join products pv on lower(pv.name) = lower(v.viejo)
    left join products pn on lower(pn.name) = lower(v.nuevo)
  loop
    -- si el producto elegido no existe, este par se omite (la verificación lo avisa)
    continue when r.nuevo_id is null;

    -- «Producto» de los tratos que tienen el nombre viejo (aunque el producto viejo ya no exista)
    insert into fusion_productos_respaldo (tabla, fila_id, valor_anterior)
      select 'deals', d.id, d.product_line from deals d where lower(d.product_line) = lower(r.viejo);
    update deals set product_line = r.nuevo_nombre where lower(product_line) = lower(r.viejo);

    -- líneas de productos y de facturas (solo si el producto viejo existe y es distinto del elegido)
    if r.viejo_id is not null and r.viejo_id <> r.nuevo_id then
      insert into fusion_productos_respaldo (tabla, fila_id, valor_anterior)
        select 'deal_line_items', x.id, x.product_id::text from deal_line_items x where x.product_id = r.viejo_id;
      insert into fusion_productos_respaldo (tabla, fila_id, valor_anterior)
        select 'invoice_line_items', x.id, x.product_id::text from invoice_line_items x where x.product_id = r.viejo_id;

      -- fila por fila: si alguna no se puede mover (la base no admite el mismo producto dos veces en un trato
      -- y ese trato ya tiene el elegido), se deja como está en vez de hacer fallar todo
      for li in select id from deal_line_items where product_id = r.viejo_id loop
        begin
          update deal_line_items set product_id = r.nuevo_id where id = li.id;
        exception when unique_violation then null;
        end;
      end loop;
      for li in select id from invoice_line_items where product_id = r.viejo_id loop
        begin
          update invoice_line_items set product_id = r.nuevo_id where id = li.id;
        exception when unique_violation then null;
        end;
      end loop;

      -- archivar el viejo solo si ya nada apunta a él (así nunca se oculta algo que aún se usa)
      if not exists (select 1 from deal_line_items where product_id = r.viejo_id)
         and not exists (select 1 from invoice_line_items where product_id = r.viejo_id) then
        insert into fusion_productos_respaldo (tabla, fila_id, valor_anterior)
          select 'products', pr.id, 'activo' from products pr where pr.id = r.viejo_id and pr.active is not false;
        update products set active = false where id = r.viejo_id;
      end if;
    end if;
  end loop;
end $$;

-- Paso 3: verificación (solo lee). Debe salir: los tres «archivado», con 0 referencias, y «ok»
select v.viejo as producto_viejo,
       case when pv.id is null then 'no existe'
            when pv.active is false then 'archivado'
            else 'ACTIVO (revisar)' end as estado_viejo,
       (select count(*) from deal_line_items where product_id = pv.id)
       + (select count(*) from invoice_line_items where product_id = pv.id)
       + (select count(*) from deals where lower(product_line) = lower(v.viejo)) as referencias_que_quedan,
       v.nuevo as se_fusionó_en,
       case when pn.id is null then 'NO EXISTE: no se fusionó' else 'ok' end as nuevo
from (values
  ('Bit Signage (Digital Signage)', 'Bit Signage'),
  ('Neomedia',                      'Cartelería Digital (Neomedia)'),
  ('WhatsApp',                      'WhatsApp Marketing')
) as v(viejo, nuevo)
left join products pv on lower(pv.name) = lower(v.viejo)
left join products pn on lower(pn.name) = lower(v.nuevo)
order by v.viejo;

-- ─────────────────────────────────────────────────────────────────────────────
-- REVERSA (solo si quisieras deshacerlo; NO correr junto con lo de arriba):
-- update deal_line_items d set product_id = b.valor_anterior::uuid from fusion_productos_respaldo b where b.tabla = 'deal_line_items' and b.fila_id = d.id;
-- update invoice_line_items d set product_id = b.valor_anterior::uuid from fusion_productos_respaldo b where b.tabla = 'invoice_line_items' and b.fila_id = d.id;
-- update deals d set product_line = b.valor_anterior from fusion_productos_respaldo b where b.tabla = 'deals' and b.fila_id = d.id;
-- update products p set active = true from fusion_productos_respaldo b where b.tabla = 'products' and b.fila_id = p.id;
