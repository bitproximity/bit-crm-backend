-- 070 · Formulario de Bit Music: antes de crear un trato nuevo, busca también el trato del cliente
-- en el pipeline Neomedia (ahí están los clientes de música). Así no se crean duplicados como el
-- de Mundo Único del 23/11.
-- Solo agrega Neomedia a settings.match_pipeline_ids del formulario «Bit Music · Perfil musical de la marca»;
-- no toca nada más de sus ajustes. Idempotente: correrlo dos veces no repite el pipeline.
update lead_forms lf
set settings = jsonb_set(
  coalesce(lf.settings, '{}'::jsonb),
  '{match_pipeline_ids}',
  (
    select coalesce(jsonb_agg(distinct x), '[]'::jsonb)
    from (
      select jsonb_array_elements_text(coalesce(lf.settings->'match_pipeline_ids', '[]'::jsonb)) as x
      union
      select p.id::text from pipelines p where lower(btrim(p.name)) = 'neomedia' and p.id <> lf.pipeline_id
    ) t
  )
)
where lf.name = 'Bit Music · Perfil musical de la marca'
   or lf.slug = 'bitmusic';

-- Verificación: debe salir el formulario con «Neomedia» en «tambien_busca_en».
select lf.name as formulario, lf.slug,
       (select string_agg(p.name, ', ') from pipelines p
         where p.id::text in (select jsonb_array_elements_text(lf.settings->'match_pipeline_ids'))) as tambien_busca_en
from lead_forms lf
where lf.name = 'Bit Music · Perfil musical de la marca' or lf.slug = 'bitmusic';
