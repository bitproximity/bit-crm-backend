// Plazo de pago por defecto según la empresa que factura. Si una factura se crea sin fecha de
// vencimiento, se calcula con la fecha de emisión + el plazo. Sin plazo definido, no se toca.
// (Regla de cobranza: Bithub SRL → 30 días, definida el 3/11/2026.)
const DEFAULT_TERMS_DAYS = {
  'Bithub SRL': 30,
};

function withDefaultDueDate(row) {
  if (!row || row.due_date || !row.issue_date) return row;
  const days = DEFAULT_TERMS_DAYS[row.source_account];
  if (!days) return row;
  const [y, m, d] = String(row.issue_date).slice(0, 10).split('-').map(Number);
  const due = new Date(Date.UTC(y, m - 1, d + days));
  return { ...row, due_date: due.toISOString().slice(0, 10) };
}

module.exports = { withDefaultDueDate, DEFAULT_TERMS_DAYS };
