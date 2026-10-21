// Corre todas las pruebas del backend en orden y resume. Uso: npm test
// (Las de rendimiento y sincronización de facturas reciben la raíz del backend como argumento.)
const { spawnSync } = require('child_process'); const path = require('path');
const root = path.resolve(__dirname, '..');
const suites = [
  ['backend.test.js'], ['product.test.js'], ['companies.test.js'], ['meeting.test.js'], ['timing.test.js'], ['dealsfilter.test.js'],
  ['invoiceParser.test.js'], ['invoiceImport.test.js'], ['quotas.test.js'], ['perf.js', root, 'ci', 'check'], ['sync.js', root, 'ci', 'check'],
].filter(([f]) => require('fs').existsSync(path.join(__dirname, f)));
let pass = 0; let fail = 0; const malas = [];
for (const [f, ...args] of suites) {
  const r = spawnSync('node', [path.join(__dirname, f), ...args], { encoding: 'utf8', timeout: 240000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const p = (out.match(/^PASS /gm) || []).length; const x = (out.match(/^FAIL /gm) || []).length;
  pass += p; fail += x; if (x || r.status) malas.push(f);
  console.log(`${x || r.status ? '✗' : '✓'} ${f.padEnd(24)} ${p} ok · ${x} fallan`);
}
console.log(`\nTotal: ${pass} ok · ${fail} fallan`);
process.exit(fail || malas.length ? 1 : 0);
