-- 071 · Equipo: poder «Eliminar definitivamente» a una persona.
-- Toda columna que apunte a team_members (contacts.owner_id y las que estén igual) pasa a
-- «on delete set null»: al borrar a la persona, sus contactos, tratos, tareas, etc. se quedan,
-- solo sin responsable. Las que ya tienen cascade / set null no se tocan.
-- Si alguna columna es NOT NULL no se puede dejar vacía: no se toca y sale listada al final.
-- Idempotente.
do $$
declare
  r record;
  nullable boolean;
begin
  for r in
    select c.oid, c.conname, c.conrelid::regclass as tbl, c.conkey,
           pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    where c.contype = 'f'
      and c.confrelid = 'public.team_members'::regclass
      and c.confdeltype in ('a', 'r')          -- no action / restrict
  loop
    select bool_and(not a.attnotnull) into nullable
    from pg_attribute a
    where a.attrelid = r.tbl and a.attnum = any (r.conkey);

    if nullable then
      execute format('alter table %s drop constraint %I', r.tbl, r.conname);
      -- Se conserva todo lo demás de la definición (on update, deferrable…); solo cambia on delete.
      execute format('alter table %s add constraint %I %s',
                     r.tbl, r.conname,
                     regexp_replace(regexp_replace(r.def, '\s+ON DELETE (RESTRICT|NO ACTION)', '', 'i'),
                                    '(REFERENCES [^)]*\))', '\1 ON DELETE SET NULL', 'i'));
      raise notice 'Ajustada: %.%', r.tbl, r.conname;
    else
      raise notice 'NO ajustada (columna NOT NULL): %.%', r.tbl, r.conname;
    end if;
  end loop;
end $$;

-- Verificación: debe salir vacío. Si sale algo, esa columna sigue bloqueando el borrado.
select c.conrelid::regclass as tabla, c.conname as restriccion, pg_get_constraintdef(c.oid) as definicion
from pg_constraint c
where c.contype = 'f'
  and c.confrelid = 'public.team_members'::regclass
  and c.confdeltype in ('a', 'r');
