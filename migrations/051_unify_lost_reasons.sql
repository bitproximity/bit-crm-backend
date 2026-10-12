-- 051 · Unifica los motivos de tratos perdidos en una lista estándar (11/10/2026).
-- La misma lista está en el frontend (DealDetail.jsx → LOST_REASONS).
-- Idempotente: se puede correr varias veces.

create or replace function pg_temp.lr_norm(t text) returns text language sql immutable as $$
  select btrim(regexp_replace(lower(translate(coalesce(t, ''), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun')), '\s+', ' ', 'g'))
$$;

update deals d set lost_reason = m.canon
from (
  select id,
    case
      when n like '%presupuesto%'                                         then 'No tiene presupuesto'
      when n like '%demo%'                                                then 'No avanzamos con el demo'
      when n like '%proveedor%' or n in ('hubspot', 'competencia')        then 'Se mantiene con el proveedor actual'
      when n like '%interes%'                                             then 'Perdió el interés'
      when n like '%dejo de responder%' or n like '%no responde%'
        or n like '%sin respuesta%'                                       then 'Dejó de responder'
      when n like '%proyecto no existe%'                                  then 'El proyecto no existe'
      when n like '%costos%' or n like '%costosa%' or n like '%costoso%'
        or n like '%caro%' or n like '%precio%'                           then 'Precio muy alto'
      when n in ('no compatible', 'estructura muy pequena', 'no tiene equipos', 'no es cliente')
        or n like '%no es perfil%'                                        then 'No es perfil de cliente'
      when n in ('standby', 'stand by', 'en pausa') or n like '%prioridad%' then 'Cambio de prioridades'
      when n like '%quebro%' or n like '%cerro%' or n like '%cambio de gobierno%'
        or n like '%empresa cerr%'                                        then 'La empresa cerró o cambió'
    end as canon
  from (select id, pg_temp.lr_norm(lost_reason) as n from deals
        where status = 'perdido' and coalesce(btrim(lost_reason), '') <> '') x
) m
where d.id = m.id and m.canon is not null and d.lost_reason is distinct from m.canon;

-- Resultado: motivos finales y cuántos tratos tiene cada uno
select coalesce(nullif(btrim(lost_reason), ''), '(sin motivo)') as motivo, count(*) as tratos
from deals where status = 'perdido'
group by 1 order by 2 desc;
