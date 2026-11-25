-- 069 · Catálogo: agrega «Portal de Smart Links», «QR Codes» y «Reservas».
-- Quedan como producto con cobro mensual, disponibles en «Producto» de los tratos.
-- Idempotente: si ya existen (con cualquier mayúscula/minúscula) no se duplican; si estaban archivados, se reactivan.
with nuevos(name) as (values ('Portal de Smart Links'), ('QR Codes'), ('Reservas'))
insert into products (name, type, billing_frequency, price, currency, active)
select n.name, 'producto', 'mensual', 0, 'USD', true
from nuevos n
where not exists (select 1 from products p where lower(btrim(p.name)) = lower(n.name));

update products set active = true
where lower(btrim(name)) in ('portal de smart links', 'qr codes', 'reservas') and active is distinct from true;

select name as producto, type as tipo, billing_frequency as cobro, active as disponible
from products
where lower(btrim(name)) in ('portal de smart links', 'qr codes', 'reservas')
order by name;
