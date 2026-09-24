-- De qué correo vino un archivo adjunto extraído automáticamente al sincronizar Gmail —
-- para no volver a guardarlo cada vez que se corre la sincronización de nuevo.
alter table deal_files add column if not exists gmail_message_id text;
