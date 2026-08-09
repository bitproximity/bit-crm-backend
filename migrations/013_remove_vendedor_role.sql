-- El rol "vendedor" se elimina. Migra a cualquiera que ya lo tuviera a "outbound"
-- (el más cercano en función: prospección/salida), ya que no se especificó destino.
update team_members set role = 'outbound' where role = 'vendedor';
