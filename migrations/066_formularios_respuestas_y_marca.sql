-- 066 · Formularios de captura: ajustes por formulario (textos, logo, colores, preguntas largas y
-- obligatorias) + registro de cada respuesta para métricas. Idempotente: se puede correr dos veces.

-- 1) Ajustes de cada formulario (título, descripción, logo, colores, etiquetas, etc.)
alter table lead_forms add column if not exists settings jsonb not null default '{}'::jsonb;

-- 2) Cada envío, tal cual llegó, con el trato al que quedó asociado
create table if not exists lead_form_submissions (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references lead_forms(id) on delete cascade,
  deal_id uuid references deals(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  company_id uuid references companies(id) on delete set null,
  matched_existing boolean not null default false,   -- true = se pegó a un trato que ya existía
  answers jsonb not null default '{}'::jsonb,         -- { name, email, phone, company, message, custom: { field_id: valor } }
  created_at timestamptz not null default now()
);
create index if not exists lead_form_submissions_form_idx on lead_form_submissions (form_id, created_at desc);
create index if not exists lead_form_submissions_deal_idx on lead_form_submissions (deal_id);

-- 3) Las respuestas de un mismo trato se actualizan (upsert) en vez de duplicarse
--    (normalmente ya existe; si no, se crea solo cuando no hay repetidos, para no frenar el script)
do $$
begin
  if not exists (
    select 1 from pg_index i join pg_class t on t.oid = i.indrelid
    where t.relname = 'custom_field_values' and i.indisunique
      and (select array_agg(a.attname::text order by a.attname) from pg_attribute a where a.attrelid = t.oid and a.attnum = any(i.indkey)) = array['entity_id', 'field_id']
  ) and not exists (
    select 1 from custom_field_values group by field_id, entity_id having count(*) > 1
  ) then
    create unique index custom_field_values_field_entity_uniq on custom_field_values (field_id, entity_id);
  end if;
end $$;

-- Resultado
select 'lead_forms.settings' as objeto, count(*)::text as filas from lead_forms
union all select 'lead_form_submissions', count(*)::text from lead_form_submissions;
