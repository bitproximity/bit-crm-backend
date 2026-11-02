-- =====================================================================
-- 058 — Esquema reporting + rol cfo_readonly (SOLO LECTURA)
--
-- REQUIERE REVISIÓN MANUAL. No aplicar en producción sin la aprobación
-- explícita del dueño. El backend NO ejecuta este archivo al desplegar:
-- hay que revisarlo y correrlo a mano en el SQL Editor de Supabase
-- (proyecto CRM Bit) antes de configurar /api/reporting.
--
-- La contraseña de más abajo es un MARCADOR. Sustitúyela por una
-- contraseña larga y única ANTES de ejecutar. Nunca dejes la contraseña
-- real en este archivo, en git ni en un chat. Si el rol ya existe, este
-- script NO le cambia la contraseña (hay que hacer ALTER ROLE aparte).
--
-- Respecto del script propuesto hay dos cambios, para que se pueda ejecutar
-- y el rol quede cerrado:
--   1. CREATE ROLE y ALTER ROLE van FUERA del begin/commit. Postgres no
--      permite esas órdenes dentro de un bloque de transacción.
--   2. search_path = reporting, para que un nombre sin esquema no caiga en public.
-- Las vistas, los GRANT y el marcador de contraseña no cambian.
--
-- Las vistas NO usan security_invoker: cfo_readonly no puede leer public,
-- así que la vista tiene que ejecutarse con el dueño que sí puede. El rol
-- solo tiene USAGE + SELECT sobre reporting. anon, authenticated y public
-- no tienen acceso al esquema.
--
-- Nota de revisión: monthly_revenue_by_country excluye solo
-- status <> 'cancelada'. La cartera de la API excluye también
-- 'cancelled' y 'anulada', igual que queries.sql.
-- =====================================================================

-- =====================================================================
-- Bit CRM (Supabase myyccgykrrhtwvbgishc): solo lectura para el CFO
-- Esquema `reporting` con vistas financieras + rol `cfo_readonly`.
-- NO EJECUTAR sin aprobación explícita de Mario.
-- Columnas tomadas de bit-crm-backend (migrations/ y src/routes/finance.js).
-- Sin PII sobrante: no se exponen notes, emails, teléfonos ni contactos.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Rol de solo lectura. Cambia la contraseña ANTES de ejecutar, y pon el
-- mismo valor en la tarjeta de secreto del CFO. Nunca la pegues en un chat.
-- Va fuera de la transacción: CREATE ROLE no puede correr dentro de un begin.
-- Si el rol ya existe, esto NO le cambia la contraseña.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cfo_readonly') then
    create role cfo_readonly login password 'CAMBIAR_POR_CONTRASEÑA_LARGA'
      nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls
      connection limit 5;
  end if;
end $$;

alter role cfo_readonly set default_transaction_read_only = on;
alter role cfo_readonly set statement_timeout = '30s';

-- Nombre sin esquema solo puede caer en reporting (pg_catalog sigue implícito).
-- Añadido en esta migración; no estaba en el borrador inicial.
alter role cfo_readonly set search_path = reporting;

begin;

create schema if not exists reporting;
-- Que el esquema no quede expuesto por la API REST pública de Supabase
revoke all on schema reporting from public, anon, authenticated;

-- Facturas (cabecera)
create or replace view reporting.invoices as
select i.id, i.invoice_number, i.client_name, i.company_id, c.name as company_name,
       c.country as company_country, i.deal_id, i.currency, i.subtotal, i.tax, i.total,
       i.paid_amount, (i.total - i.paid_amount) as balance_due, i.status,
       i.issue_date, i.due_date, i.external_source, i.source_account,
       i.created_at, i.updated_at
from public.invoices i
left join public.companies c on c.id = i.company_id;

-- Líneas de factura
create or replace view reporting.invoice_line_items as
select li.id, li.invoice_id, li.product_id, p.name as product_name,
       li.description, li.quantity, li.unit_price, (li.quantity * li.unit_price) as line_total,
       li.created_at
from public.invoice_line_items li
left join public.products p on p.id = li.product_id;

-- Cobros (sin notes)
create or replace view reporting.invoice_payments as
select ip.id, ip.invoice_id, i.currency, ip.amount, ip.paid_at, ip.method
from public.invoice_payments ip
join public.invoices i on i.id = ip.invoice_id;

-- Tratos (sin contacto ni dueño)
create or replace view reporting.deals as
select d.id, d.title, d.value, d.currency, d.status, d.company_id,
       c.name as company_name, c.country as company_country,
       pl.name as pipeline_name, d.product_line, d.billing_frequency,
       d.facturacion, d.hardware_type, d.created_at, d.closed_at
from public.deals d
left join public.companies c on c.id = d.company_id
left join public.pipelines pl on pl.id = d.pipeline_id;

-- Empresas (solo datos comerciales básicos)
create or replace view reporting.companies as
select id, name, country, is_b2b_client, created_at
from public.companies;

-- Catálogo de productos
create or replace view reporting.products as
select id, name, sku, type, price, currency, billing_frequency, active
from public.products;

-- Tasas de cambio (para consolidar en USD)
create or replace view reporting.exchange_rates as
select * from public.exchange_rates;

-- Resumen mensual por país y moneda
create or replace view reporting.monthly_revenue_by_country as
select date_trunc('month', i.issue_date)::date as month,
       coalesce(c.country, 'Sin país') as country, i.currency,
       count(*) as invoices, sum(i.total) as invoiced, sum(i.paid_amount) as collected,
       sum(i.total - i.paid_amount) as outstanding
from public.invoices i
left join public.companies c on c.id = i.company_id
where i.status <> 'cancelada'
group by 1, 2, 3;

-- Nada en public ni en otros esquemas
revoke all on schema public from cfo_readonly;
revoke all on all tables in schema public from cfo_readonly;

-- Solo leer las vistas de reporting
grant usage on schema reporting to cfo_readonly;
grant select on all tables in schema reporting to cfo_readonly;

commit;

-- Verificación (correr conectado como cfo_readonly):
--   select count(*) from reporting.invoices;      -- debe funcionar
--   select count(*) from public.invoices;         -- debe fallar (permission denied)
--   insert into reporting.companies(name) values ('x');  -- debe fallar
-- Conexión: pooler de Supabase, usuario `cfo_readonly.myyccgykrrhtwvbgishc`.
-- Revertir: drop schema reporting cascade; drop role cfo_readonly;
