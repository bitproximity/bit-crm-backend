-- Campos nuevos en contactos para que el formulario de edición tenga cédula y zona,
-- igual que el formato de Bit WiFi. (Fecha de nacimiento y género no se agregan — no
-- hacen falta.)
alter table contacts add column if not exists cedula text;
alter table contacts add column if not exists zone text;
