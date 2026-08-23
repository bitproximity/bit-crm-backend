-- "meeting_date" ya se usaba como fecha programada; se agrega una fecha separada
-- para cuando la reunión efectivamente se realizó (pueden no coincidir).
ALTER TABLE b2b_records ADD COLUMN IF NOT EXISTS realized_date timestamptz;
