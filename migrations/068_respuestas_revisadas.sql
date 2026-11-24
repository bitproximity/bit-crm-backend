-- 068 · Bandeja de respuestas de formularios: marcar cada respuesta como revisada/asignada.
-- Idempotente: se puede correr dos veces.
alter table lead_form_submissions add column if not exists reviewed_at timestamptz;
alter table lead_form_submissions add column if not exists reviewed_by uuid references team_members(id) on delete set null;

-- Las que ya se pegaron a un trato existente cuentan como revisadas.
update lead_form_submissions set reviewed_at = created_at where matched_existing and reviewed_at is null;

select count(*) filter (where reviewed_at is null) as por_revisar, count(*) as total from lead_form_submissions;
