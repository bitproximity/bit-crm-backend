-- Guarda el ID del evento de Google Calendar vinculado a cada tarea, para poder
-- actualizarlo o borrarlo cuando la tarea cambie.
alter table tasks add column if not exists google_event_id text;
