-- Agrega País y Cargo a Contactos (no existían)
alter table contacts add column if not exists country text;
alter table contacts add column if not exists position text;
