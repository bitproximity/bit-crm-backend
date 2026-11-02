// CSV mínimo, sin dependencias. Neutraliza fórmulas de una hoja de cálculo
// (=, +, @, tabulador, y un "-" que no es un número) sin convertir los importes negativos en texto.
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : String(value);
  if (/^[=+@\t\r]/.test(s) || /^-(?!\d+(\.\d+)?$)/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, columns) {
  const cols = Array.isArray(columns) && columns.length ? columns : (rows[0] ? Object.keys(rows[0]) : []);
  const lines = [cols.map(csvCell).join(',')];
  for (const row of rows || []) lines.push(cols.map((col) => csvCell(row[col])).join(','));
  return `${lines.join('\n')}\n`;
}

module.exports = { csvCell, toCsv };
