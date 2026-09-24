-- Para traer facturas de Stripe y Alegra al módulo de Facturación sin duplicarlas en cada
-- sincronización: se guarda de dónde vino cada una y su ID original en esa plataforma.
alter table invoices add column if not exists external_source text;
alter table invoices add column if not exists external_id text;

-- Único por plataforma+ID — permite null (facturas cargadas a mano, como las 234 del Excel
-- importado antes, no tienen esto) pero evita que la misma factura de Stripe/Alegra se
-- inserte dos veces si se corre la sincronización de nuevo.
create unique index if not exists invoices_external_unique
  on invoices (external_source, external_id)
  where external_source is not null and external_id is not null;
