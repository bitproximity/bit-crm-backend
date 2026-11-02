-- 060 · Churn: cancelación de clientes recurrentes (27/10/2026). Idempotente.
-- Un trato ganado mensual/anual con churned_at deja de sumar al MRR activo desde esa fecha.
alter table deals add column if not exists churned_at date;
alter table deals add column if not exists churn_reason text;
create index if not exists idx_deals_churned_at on deals(churned_at) where churned_at is not null;
select count(*) filter (where churned_at is not null) as tratos_con_churn from deals;
