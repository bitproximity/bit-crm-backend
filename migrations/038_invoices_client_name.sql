-- Razón social del cliente al que se facturó — hoy solo vivía enterrada dentro del texto
-- de "notes" ("Importado de Stripe - Nombre Cliente (email)"), sin poder verse ni editarse
-- como campo propio en la lista ni en el detalle de la factura.
alter table invoices add column if not exists client_name text;
