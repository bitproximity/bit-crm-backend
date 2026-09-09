-- Campos nuevos en contactos para que el formulario de edición tenga cédula, fecha de
-- nacimiento, género y zona, igual que el formato de Bit WiFi.
alter table contacts add column if not exists cedula text;
alter table contacts add column if not exists birth_date date;
alter table contacts add column if not exists gender text;
alter table contacts add column if not exists zone text;
