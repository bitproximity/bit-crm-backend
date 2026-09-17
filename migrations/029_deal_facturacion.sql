-- Campo "Facturación" en tratos: por cuál entidad/país se factura el trato (Bit Colombia,
-- Bit Ecuador, Bit LLC, etc.) — independiente del pipeline o del país de la empresa, que
-- ya se usaban como aproximación pero no siempre coinciden con quién factura de verdad.
alter table deals add column if not exists facturacion text;
