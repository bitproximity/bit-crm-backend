-- Facturación: facturas ligadas a deals/empresas/contactos, con líneas y pagos
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text,
  deal_id uuid references deals(id) on delete set null,
  company_id uuid references companies(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  currency text not null default 'USD',
  subtotal numeric not null default 0,
  tax numeric not null default 0,
  total numeric not null default 0,
  paid_amount numeric not null default 0,
  status text not null default 'pendiente', -- pendiente, parcial, pagada, cancelada
  issue_date date default current_date,
  due_date date,
  notes text,
  created_by uuid references team_members(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists invoice_line_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references invoices(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  description text,
  quantity numeric not null default 1,
  unit_price numeric not null default 0,
  created_at timestamptz default now()
);

create table if not exists invoice_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references invoices(id) on delete cascade,
  amount numeric not null,
  paid_at timestamptz default now(),
  method text,
  notes text,
  recorded_by uuid references team_members(id) on delete set null,
  created_at timestamptz default now()
);

create index if not exists idx_invoices_deal on invoices(deal_id);
create index if not exists idx_invoices_company on invoices(company_id);
create index if not exists idx_invoices_status on invoices(status);
create index if not exists idx_invoice_line_items_invoice on invoice_line_items(invoice_id);
create index if not exists idx_invoice_payments_invoice on invoice_payments(invoice_id);
