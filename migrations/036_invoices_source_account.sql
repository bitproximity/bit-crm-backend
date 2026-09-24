-- De qué cuenta/empresa vino la factura sincronizada (ej. Alegra tiene 2 cuentas — "BIT" y
-- una personal — así se distinguen sin tener que abrir cada una para saber de cuál es).
alter table invoices add column if not exists source_account text;
