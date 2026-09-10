-- Campos nuevos en contactos para que el formulario de edición tenga cédula, género y
-- zona, igual que el formato de Bit WiFi. (Fecha de nacimiento no se agrega — no hace falta.)
alter table contacts add column if not exists cedula text;
alter table contacts add column if not exists gender text;
alter table contacts add column if not exists zone text;
