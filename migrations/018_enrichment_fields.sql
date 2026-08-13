ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin_url text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enriched_at timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enrichment_source text;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS linkedin_url text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS employee_count text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS enriched_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS enrichment_source text;
