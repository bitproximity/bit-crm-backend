-- Permite conectar más de una cuenta de Gmail/Google por persona (ej. mario@bitproximity.com
-- + mario@bitwifiapp.com). Antes había un UNIQUE solo en team_member_id, así que conectar una
-- segunda cuenta pisaba silenciosamente a la primera (mismo upsert, mismo conflicto).
-- Busca dinámicamente el nombre real del constraint en vez de asumirlo, porque Postgres lo
-- genera automático y puede no llamarse igual en cada entorno.
DO $$
DECLARE
  conname text;
BEGIN
  SELECT con.conname INTO conname
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'gmail_connections'
    AND con.contype = 'u'
    AND con.conkey = (
      SELECT array_agg(attnum ORDER BY attnum)
      FROM pg_attribute
      WHERE attrelid = rel.oid AND attname = 'team_member_id'
    );
  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE gmail_connections DROP CONSTRAINT %I', conname);
  END IF;
END $$;

ALTER TABLE gmail_connections
  ADD CONSTRAINT gmail_connections_team_member_email_key UNIQUE (team_member_id, email);
