-- Unifica "Diana Sanchez" (sin tilde, viene de la variable de entorno de Facturero Móvil)
-- con "Diana Sánchez" (con tilde, la grafía correcta y la que usa el desplegable de
-- Facturación) — hasta ahora eran dos filas distintas en "Facturado por empresa".
update invoices set source_account = 'Diana Sánchez' where source_account = 'Diana Sanchez';
update invoices set notes = replace(notes, '(Diana Sanchez)', '(Diana Sánchez)') where notes like '%(Diana Sanchez)%';
