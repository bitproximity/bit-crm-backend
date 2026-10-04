-- 050 — Documentos por empresa/proyecto + restricciones por usuario + limpieza de Google ajeno
-- Idempotente: se puede correr más de una vez sin romper nada.

-- ─── 1. Documentos asociados a una EMPRESA (antes solo a trato o proyecto) ───
alter table documents add column if not exists company_id uuid references companies(id) on delete set null;
create index if not exists idx_documents_company on documents(company_id);

-- Backfill: la empresa sale del proyecto o del trato al que ya estaba vinculado el documento
update documents d set company_id = p.company_id
from projects p
where d.project_id = p.id and d.company_id is null and p.company_id is not null;

update documents d set company_id = de.company_id
from deals de
where d.deal_id = de.id and d.company_id is null and de.company_id is not null;

-- Las subpáginas heredan empresa/proyecto/trato de su página raíz (antes quedaban sueltas)
with recursive chain as (
  select id, id as root_id from documents where parent_id is null
  union all
  select d.id, c.root_id from documents d join chain c on d.parent_id = c.id
)
update documents d set
  company_id = coalesce(d.company_id, r.company_id),
  project_id = coalesce(d.project_id, r.project_id),
  deal_id    = coalesce(d.deal_id, r.deal_id)
from chain c join documents r on r.id = c.root_id
where d.id = c.id and d.id <> c.root_id;

-- ─── 2. Merge de empresas: b2b_records ya no se borra en cascada ───
-- Antes, borrar una empresa (incluido fusionar duplicados) borraba todos sus registros
-- de Bit Prospect. Ahora quedan con client_company_id NULL en vez de desaparecer.
alter table b2b_records drop constraint if exists b2b_records_client_company_id_fkey;
alter table b2b_records add constraint b2b_records_client_company_id_fkey
  foreign key (client_company_id) references companies(id) on delete set null;

-- ─── 3. Secciones bloqueadas por usuario (además del rol) ───
-- Ej. un admin que no debe ver Facturación. Aplica también a admin.
alter table team_members add column if not exists blocked_pages text[] not null default '{}';

update team_members
set blocked_pages = array(select distinct unnest(blocked_pages || array['facturacion', 'agenda_equipo']))
where lower(email) = 'support@bitproximity.com';  -- Diego Molina: sin Facturación ni la agenda de los demás

-- ─── 4. Cuentas de Google/Cal.com conectadas bajo el usuario equivocado ───
-- Una misma cuenta de Google solo puede pertenecer a UN miembro del equipo. Si alguien
-- conectó el Google de otra persona (ej. el de Mario en la sesión de Diego), su
-- Dashboard mostraba el calendario de esa otra persona. Se conserva la conexión del
-- dueño real: el miembro cuyo login coincide con el email, o si no, el primero que la conectó.
delete from gmail_connections g
using team_members t
where lower(t.email) = lower(g.email) and t.id <> g.team_member_id;

delete from gmail_connections g
where exists (
  select 1 from gmail_connections o
  left join team_members ot on ot.id = o.team_member_id
  where lower(o.email) = lower(g.email)
    and o.team_member_id <> g.team_member_id
    and (
      lower(ot.email) = 'mario@bitproximity.com'   -- si choca con Mario, gana Mario
      or (
        g.team_member_id not in (select id from team_members where lower(email) = 'mario@bitproximity.com')
        and o.ctid < g.ctid
      )
    )
);

-- Mismo criterio para Cal.com: la misma API key no puede estar en dos usuarios
delete from calcom_connections c
where exists (
  select 1 from calcom_connections o
  join team_members t on t.id = o.team_member_id
  where o.api_key = c.api_key and o.team_member_id <> c.team_member_id
    and lower(t.email) = 'mario@bitproximity.com'
);

create unique index if not exists gmail_connections_email_unique on gmail_connections (lower(email));
