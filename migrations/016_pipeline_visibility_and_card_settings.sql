ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false;
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS color text;

CREATE TABLE IF NOT EXISTS crm_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO crm_settings (key, value)
VALUES ('deal_card_fields', '{"company": true, "contact": true, "value": true, "due_date_warning": true, "avatar": true}'::jsonb)
ON CONFLICT (key) DO NOTHING;
