// Consultas del asistente financiero. Los textos son fijos; fechas y números van
// siempre como parámetros. La lista de estados anulados es la de queries.sql.
const { nextMonthStart } = require('./params');

const NOT_CANCELLED = "not in ('cancelada', 'cancelled', 'anulada')";

const RECEIVABLES_COLUMNS = [
  'invoice_number', 'source_account', 'external_source', 'cliente', 'pais', 'currency',
  'total', 'paid_amount', 'balance_due', 'status', 'issue_date', 'due_date', 'dias_vencida', 'rango',
];

// $1 = fecha de hoy en la zona del negocio (no current_date del servidor, que en UTC
// marca como vencida una factura que en Panamá todavía vence hoy).
const RECEIVABLES_SQL = `
select
  invoice_number,
  source_account,
  external_source,
  coalesce(company_name, client_name) as cliente,
  company_country as pais,
  currency,
  total,
  paid_amount,
  balance_due,
  status,
  issue_date,
  due_date,
  greatest($1::date - due_date, 0) as dias_vencida,
  case
    when due_date >= $1::date then 'Por vencer'
    when ($1::date - due_date) <= 30 then '1-30'
    when ($1::date - due_date) <= 60 then '31-60'
    when ($1::date - due_date) <= 90 then '61-90'
    else '90+'
  end as rango
from reporting.invoices
where balance_due > 0
  and status ${NOT_CANCELLED}
order by balance_due desc
`;

const TOTALS_BY_CURRENCY_SQL = `
select
  currency,
  count(*)::int as invoice_count,
  sum(balance_due) as total,
  sum(balance_due) filter (where due_date < $1::date) as vencido
from reporting.invoices
where balance_due > 0
  and status ${NOT_CANCELLED}
group by 1
order by 1
`;

const TOTALS_BY_COUNTRY_SQL = `
select
  coalesce(company_country, 'Sin país') as pais,
  currency,
  count(*)::int as invoice_count,
  sum(balance_due) as total
from reporting.invoices
where balance_due > 0
  and status ${NOT_CANCELLED}
group by 1, 2
order by 1, 2
`;

const WON_COLUMNS = [
  'title', 'company_name', 'company_country', 'product_line', 'value', 'currency',
  'closed_at', 'billing_frequency', 'facturacion',
];

const WON_WITHOUT_INVOICE_SQL = `
select
  d.title,
  d.company_name,
  d.company_country,
  d.product_line,
  d.value,
  d.currency,
  d.closed_at,
  d.billing_frequency,
  d.facturacion
from reporting.deals d
where d.status in ('won', 'ganado')
  and not exists (
    select 1 from reporting.invoices i where i.deal_id = d.id
  )
order by d.value desc nulls last
`;

const MONTHLY_COLUMNS = ['month', 'country', 'currency', 'invoices', 'invoiced', 'collected', 'outstanding'];

const MONTHLY_SQL = `
select month, country, currency, invoices, invoiced, collected, outstanding
from reporting.monthly_revenue_by_country
where ($1::date is null or month >= $1::date)
  and ($2::date is null or month < $2::date)
order by month, country, currency
`;

const PAYMENT_COLUMNS = ['paid_at', 'invoice_number', 'cliente', 'company_country', 'currency', 'amount', 'method'];

// $1 fecha de hoy, $2 zona horaria del negocio, $3 días hacia atrás.
// El corte es la medianoche de esa zona, no la medianoche UTC.
const PAYMENTS_SQL = `
select
  p.paid_at,
  i.invoice_number,
  coalesce(i.company_name, i.client_name) as cliente,
  i.company_country,
  p.currency,
  p.amount,
  p.method
from reporting.invoice_payments p
join reporting.invoices i on i.id = p.invoice_id
where (p.paid_at at time zone $2)::date >= ($1::date - $3::int)
order by p.paid_at desc
`;

const RATE_COLUMNS = ['currency', 'rate_to_usd', 'updated_at'];

const EXCHANGE_RATES_SQL = `
select currency, rate_to_usd, updated_at
from reporting.exchange_rates
order by currency
`;

function monthlyQuery({ from, to }) {
  return {
    text: MONTHLY_SQL,
    values: [from ? `${from}-01` : null, to ? nextMonthStart(to) : null],
  };
}

function paymentsQuery({ today, days, timeZone }) {
  return { text: PAYMENTS_SQL, values: [today, timeZone, days] };
}

module.exports = {
  NOT_CANCELLED,
  RECEIVABLES_COLUMNS,
  RECEIVABLES_SQL,
  TOTALS_BY_CURRENCY_SQL,
  TOTALS_BY_COUNTRY_SQL,
  WON_COLUMNS,
  WON_WITHOUT_INVOICE_SQL,
  MONTHLY_COLUMNS,
  MONTHLY_SQL,
  PAYMENT_COLUMNS,
  PAYMENTS_SQL,
  RATE_COLUMNS,
  EXCHANGE_RATES_SQL,
  monthlyQuery,
  paymentsQuery,
};
