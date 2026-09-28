-- El tipo "Follow up" (key: followup) existe en la interfaz (DealDetail y Actividades) pero el
-- constraint de la tabla nunca se actualizó para aceptarlo: cualquier intento de registrar un
-- Follow up en un trato terminaba en "violates check constraint activities_type_check".
-- Se recrea el constraint con TODOS los tipos que usa la interfaz hoy.
alter table activities drop constraint if exists activities_type_check;
alter table activities add constraint activities_type_check
  check (type in ('llamada', 'email', 'reunion', 'nota', 'whatsapp', 'tarea', 'followup'));
