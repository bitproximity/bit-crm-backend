-- Agrega orden manual a los pipelines (antes se ordenaban por created_at)
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS position integer;

-- Orden inicial según el criterio de Mario (igual que Pipedrive)
UPDATE pipelines SET position = 0 WHERE name ILIKE 'WiFi Marketing';
UPDATE pipelines SET position = 1 WHERE name ILIKE 'Neomedia';
UPDATE pipelines SET position = 2 WHERE name ILIKE 'BIT MUSIC';
UPDATE pipelines SET position = 3 WHERE name ILIKE 'Bit México';
UPDATE pipelines SET position = 4 WHERE name ILIKE 'Bit Ecuador';
UPDATE pipelines SET position = 5 WHERE name ILIKE 'Bit Colombia';
UPDATE pipelines SET position = 6 WHERE name ILIKE 'Bit RD';
UPDATE pipelines SET position = 7 WHERE name ILIKE 'Bit Panamá';
UPDATE pipelines SET position = 8 WHERE name ILIKE 'Bit LLC';
UPDATE pipelines SET position = 9 WHERE name ILIKE 'Bit Paraguay';
UPDATE pipelines SET position = 10 WHERE name ILIKE 'Omnicanalidad';

-- Cualquier pipeline nuevo que no tenga posición asignada cae al final
UPDATE pipelines SET position = 999 WHERE position IS NULL;
