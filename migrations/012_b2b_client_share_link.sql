-- Vuelve el link público a nivel de Empresa/marca (no de Proyecto), que es como
-- realmente se organiza Bit Prospect: un cliente = una empresa con su propia base.
alter table companies add column if not exists b2b_share_token uuid;
create unique index if not exists idx_companies_b2b_share_token on companies(b2b_share_token) where b2b_share_token is not null;
