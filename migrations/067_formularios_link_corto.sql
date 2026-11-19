-- 067 · Link corto para los formularios (crm.bitproximity.com/public/bitmusic). Idempotente.
alter table lead_forms add column if not exists slug text;
create unique index if not exists lead_forms_slug_uniq on lead_forms (slug) where slug is not null;

-- El formulario de Bit Music queda en /public/bitmusic
update lead_forms set slug = 'bitmusic'
where name = 'Bit Music · Perfil musical de la marca' and slug is null
  and not exists (select 1 from lead_forms where slug = 'bitmusic');

-- Resultado
select name as formulario, coalesce('https://crm.bitproximity.com/public/' || slug, '(sin link corto)') as link
from lead_forms order by created_at;
