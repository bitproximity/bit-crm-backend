-- Más personas dentro de un trato, además del contacto principal (deals.contact_id) — para
-- casos donde hay varios interlocutores del lado del cliente (ej. quien decide y quien usa
-- el producto). Es una tabla aparte, no reemplaza al contacto principal.
create table if not exists deal_contacts (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  role text,
  created_at timestamptz default now(),
  unique (deal_id, contact_id)
);
create index if not exists deal_contacts_deal_idx on deal_contacts (deal_id);
