-- Mismo problema que activities (migración 041): la interfaz ofrece opciones que los
-- constraints de la tabla projects no aceptan, y crear/editar con esas opciones falla.
--   - Tipo "Instalación" (instalacion) y "Soporte" (soporte): rechazados por projects_type_check.
--   - Estado "Cancelado" (cancelado): rechazado por projects_status_check.
-- Se recrean ambos con TODAS las opciones que usa la interfaz (Projects.jsx / ProjectDetail.jsx).
-- Los 116 proyectos existentes son todos onboarding_cliente / activo, así que no se afecta ningún dato.
alter table projects drop constraint if exists projects_type_check;
alter table projects add constraint projects_type_check
  check (type in ('onboarding_cliente', 'instalacion', 'implementacion', 'soporte', 'otro'));

alter table projects drop constraint if exists projects_status_check;
alter table projects add constraint projects_status_check
  check (status in ('activo', 'pausado', 'completado', 'cancelado'));
