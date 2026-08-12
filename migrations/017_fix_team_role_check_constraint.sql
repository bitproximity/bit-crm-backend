-- El constraint quedó desactualizado desde la migración 013 (vendedor -> outbound):
-- los datos se renombraron pero el constraint nunca se tocó, así que seguía
-- exigiendo 'vendedor' y rechazaba 'outbound' en cualquier UPDATE/INSERT nuevo.
ALTER TABLE team_members DROP CONSTRAINT IF EXISTS team_members_role_check;
ALTER TABLE team_members ADD CONSTRAINT team_members_role_check
  CHECK (role IN ('admin', 'outbound', 'operaciones'));
