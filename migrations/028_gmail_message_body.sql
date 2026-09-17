-- Antes solo se guardaba el snippet (el fragmento corto de ~100 caracteres que devuelve
-- Gmail como preview) porque la sincronización pedía los mensajes con format='metadata'.
-- Se agregan columnas para el cuerpo completo del correo, en texto plano y en HTML.
alter table gmail_messages add column if not exists body_text text;
alter table gmail_messages add column if not exists body_html text;
