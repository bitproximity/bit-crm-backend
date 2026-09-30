-- Qué preguntas extra hace cada formulario de leads, además de nombre/correo/teléfono/
-- empresa/mensaje — son los MISMOS campos personalizados que ya existen para "trato" en
-- Configuración > Campos personalizados (no un sistema de preguntas aparte), así que la
-- respuesta queda guardada como dato real y consultable en el trato, no como texto suelto.
alter table lead_forms add column if not exists field_ids uuid[] not null default '{}';
