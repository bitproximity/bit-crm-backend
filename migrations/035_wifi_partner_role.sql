-- Agrega 'wifi_partner' (socio externo, ej. Bit WiFi, restringido a un solo pipeline)
-- a los roles permitidos.
ALTER TABLE team_members DROP CONSTRAINT IF EXISTS team_members_role_check;
ALTER TABLE team_members ADD CONSTRAINT team_members_role_check
  CHECK (role IN ('admin', 'outbound', 'operaciones', 'wifi_partner'));
