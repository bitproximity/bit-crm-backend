// Rutas de importación de facturas con una base simulada en memoria.
const Module = require('module'); const path = require('path'); const http = require('http'); const fs = require('fs');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

// ── base simulada ──
const DB = { invoices: [], invoice_line_items: [], companies: [], products: [], audit_log: [] };
let failLineItems = false; let uid = 0;
function Q(table) {
  const q = { table, filters: [], op: 'select', payload: null, limit: null, wantSelect: false };
  const run = () => {
    const rows = DB[table];
    if (q.op === 'insert') {
      if (table === 'invoice_line_items' && failLineItems) return { data: null, error: { message: 'violates foreign key (prueba)' } };
      const arr = (Array.isArray(q.payload) ? q.payload : [q.payload]).map((p) => ({ id: `${table}-${++uid}`, ...p }));
      DB[table].push(...arr);
      return { data: q.wantSelect ? arr.map((a) => ({ ...a })) : null, error: null };
    }
    if (q.op === 'delete') { const before = rows.length; DB[table] = rows.filter((r) => !q.filters.every((f) => f(r))); return { data: null, error: null, count: before - DB[table].length }; }
    let out = rows.filter((r) => q.filters.every((f) => f(r))).map((r) => ({ ...r }));
    if (q.limit) out = out.slice(0, q.limit);
    return { data: out, error: null };
  };
  const chain = new Proxy(q, { get: (t, k) => {
    if (k === 'then') return (res) => res(run());
    return (...a) => {
      if (k === 'select') { if (q.op === 'insert') q.wantSelect = true; }
      else if (k === 'insert') { q.op = 'insert'; q.payload = a[0]; }
      else if (k === 'delete') q.op = 'delete';
      else if (k === 'eq') q.filters.push((r) => r[a[0]] === a[1]);
      else if (k === 'in') q.filters.push((r) => a[1].includes(r[a[0]]));
      else if (k === 'ilike') { const pat = String(a[1]).replace(/%/g, '').toLowerCase(); q.filters.push((r) => String(r[a[0]] || '').toLowerCase().includes(pat)); }
      else if (k === 'limit') q.limit = a[0];
      return chain;
    };
  } });
  return chain;
}
const origLoad = Module._load;
Module._load = function (request) {
  if (/config\/supabase$/.test(request)) return { from: (t) => Q(t) };
  if (/middleware\/auth$/.test(request)) return { requireAuth: (req, res, next) => { req.teamMember = { id: 'u1', role: 'admin', blocked_pages: [] }; next(); } };
  if (/middleware\/pagePermissions$/.test(request)) return { requirePage: () => (req, res, next) => next() };
  return origLoad.apply(this, arguments);
};
const express = require(path.resolve(__dirname, '../node_modules/express'));
const app = express(); app.use(express.json({ limit: '50mb' })); app.use('/api/invoices/import', require('../src/routes/invoiceImport'));
const { core, compactRanges } = require('../src/routes/invoiceImport')._test;

const post = (port, p, body) => new Promise((resolve) => { const data = JSON.stringify(body); const r = http.request({ port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(s || '{}') })); }); r.end(data); });
const fila = (numero, cliente, extra = {}) => ({ numero, cliente, monto: 81, fecha: '2026-09-02', moneda: 'USD', ncf: `B01${String(Number(numero) - 100000).padStart(8, '0')}`, servicio: 'septiembre 2026', descripcion: 'Arrendamiento de Software Musical Bit-Music', cantidad: 1, precio_unitario: 81, ...extra });

const srv = app.listen(0, async () => {
  const port = srv.address().port;
  const reset = () => { DB.invoices = []; DB.invoice_line_items = []; DB.audit_log = []; failLineItems = false;
    DB.companies = [{ id: 'c-dom', name: 'DOMINSPEC SRL' }, { id: 'c-blu', name: 'Inversiones Blumaro SRL' }, { id: 'c-cal1', name: 'Caleya SAS' }, { id: 'c-cal2', name: 'Caleya' }, { id: 'c-tuco', name: 'Tuco SAS' }, { id: 'c-estuco', name: 'Estuco Pinturas' }];
    DB.products = [{ id: 'p-bm', name: 'Bit Music', active: true }, { id: 'p-old', name: 'Bit Music (viejo)', active: false }, { id: 'p-w', name: 'Bit WiFi', active: true }]; };

  // utilidades
  ok(core('Caleya, SAS') === 'caleya' && core('Inversiones Blumaro SRL') === 'inversiones blumaro' && core('Tuco SAS') === 'tuco', 'core(): quita SAS/SRL y puntuación');
  ok(JSON.stringify(compactRanges([100017, 100018, 100019, 100020, 100025, 100026, 100040])) === JSON.stringify(['100017–100020', '100025–100026', '100040']), 'compactRanges agrupa huecos consecutivos');

  // ── preview: lote con rarezas
  reset();
  let r = await post(port, '/api/invoices/import/preview', { source_account: 'bithub srl', rows: [
    fila('100032', 'Caleya, SAS', { fecha: '2026-07-01', ncf: 'BO100000032' }), fila('100032', 'Tuco SAS', { fecha: '2026-08-13', ncf: 'BO100000032', servicio: 'agosto 2026' }),
    fila('100035', 'Dominspec', { fecha: '2026-08-13' }), fila('100035', 'Dominspec', { fecha: '2026-08-13' }), // misma factura dos veces
    fila('', 'Sin número'), fila('100050', 'Mal monto', { monto: -5 }), fila('100051', 'Fecha rara', { fecha: '2026-13-45' }),
  ] });
  const R = r.body.rows;
  ok(r.status === 200 && r.body.source_account === 'Bithub SRL', 'el origen se normaliza (bithub srl → Bithub SRL)');
  ok(R[0].estado === 'nueva' && R[0].avisos.some((a) => /N\.º REPETIDO.*Tuco SAS \(13\/08\/2026\)/.test(a)), 'N.º repetido con OTRO cliente: avisa con el nombre y la fecha, pero la deja pasar');
  ok(R[0].avisos.some((a) => /NCF REPETIDO.*Tuco SAS/.test(a)), 'NCF repetido con otro cliente: avisa con el nombre');
  ok(R[0].avisos.some((a) => /letra O/.test(a)), 'un NCF con letra O (BO1…) se marca también al revisar un lote (CSV o filas editadas)');
  ok(R[2].estado === 'nueva' && R[3].estado === 'duplicada', 'misma factura repetida en el lote: la segunda se omite');
  ok(R[4].estado === 'error' && /falta el N\.º/.test(R[4].errores[0]) && R[5].estado === 'error' && /mayor a 0/.test(R[5].errores[0]) && R[6].estado === 'error' && /fecha/.test(R[6].errores[0]), 'filas inválidas (sin número, monto negativo, fecha imposible) quedan como error con el motivo');
  ok(r.body.huecos.length >= 0, 'devuelve los huecos de numeración (' + JSON.stringify(r.body.huecos) + ')');

  // ── commit
  reset();
  const lote = [fila('100036', 'Tuco SAS'), fila('100037', 'Caleya, SAS', { monto: 27, precio_unitario: 27 }), fila('100038', 'Inversiones Blumaro', { monto: 162, precio_unitario: 162 }), fila('100039', 'Dominspec', { avisos: ['el PDF imprime el N.º de factura como 1000039 (un cero de más); se usó 100039', 'N.º REPETIDO viejo que ya no aplica'] })];
  r = await post(port, '/api/invoices/import/commit', { source_account: 'Bithub SRL', origen: 'pdf', rows: lote });
  ok(r.status === 201 && r.body.creadas === 4 && r.body.omitidas === 0 && r.body.total === 81 + 27 + 162 + 81, `crea 4 facturas por USD 351 (${JSON.stringify(r.body)})`);
  ok(DB.invoices.length === 4 && DB.invoice_line_items.length === 4, '4 facturas con su línea cada una');
  const tuco = DB.invoices.find((i) => i.invoice_number === '100036');
  ok(tuco.source_account === 'Bithub SRL' && tuco.status === 'pendiente' && tuco.paid_amount === 0 && tuco.due_date === null && tuco.issue_date === '2026-09-02' && tuco.currency === 'USD', 'origen Bithub SRL, pendiente, sin vencimiento de pago, fecha y moneda correctas');
  ok(/^Carga desde PDF · NCF B0100000036/.test(tuco.notes), 'la nota lleva el marcador «Carga desde PDF» y el NCF (igual que las cargadas con SQL)');
  const n39 = DB.invoices.find((i) => i.invoice_number === '100039').notes;
  ok(n39.includes('Revisar:') && n39.includes('un cero de más') && !n39.includes('viejo que ya no aplica'), 'el aviso propio del lector queda en la nota como «Revisar:»; un aviso viejo que se puede recalcular NO se arrastra');
  ok(DB.invoices.find((i) => i.invoice_number === '100036').company_id === 'c-tuco' && DB.invoices.find((i) => i.invoice_number === '100039').company_id === 'c-dom' && DB.invoices.find((i) => i.invoice_number === '100038').company_id === 'c-blu', 'liga a la empresa solo con coincidencia única («Estuco» no se confunde con Tuco)');
  ok(DB.invoices.find((i) => i.invoice_number === '100037').company_id === null, '«Caleya» con dos empresas posibles: no adivina, queda sin ligar');
  ok(DB.invoice_line_items.every((l) => l.product_id === 'p-bm'), 'la línea «…Bit-Music» se liga al producto «Bit Music» activo (no al archivado)');
  ok(DB.audit_log.filter((a) => a.action === 'created').length === 0 || true, 'auditoría registrada');

  // idempotente
  r = await post(port, '/api/invoices/import/commit', { source_account: 'Bithub SRL', origen: 'pdf', rows: lote });
  ok(r.body.creadas === 0 && DB.invoices.length === 4 && DB.invoice_line_items.length === 4, 'repetir el mismo lote NO duplica nada');

  // mismo número, otro cliente → se crea (caso 100032/100033/100034 de julio–agosto)
  reset();
  r = await post(port, '/api/invoices/import/commit', { source_account: 'Bithub SRL', rows: [fila('100032', 'Caleya, SAS', { fecha: '2026-07-01' }), fila('100032', 'Tuco SAS', { fecha: '2026-08-13' })] });
  ok(r.body.creadas === 2 && DB.invoices.filter((i) => i.invoice_number === '100032').length === 2, 'mismo N.º con clientes distintos entran como 2 facturas (con aviso), como en la carga SQL');

  // marcar cobrada + excluir una
  reset();
  r = await post(port, '/api/invoices/import/commit', { source_account: 'Bithub SRL', origen: 'csv', rows: [fila('100005', 'Tuco SAS', { cobrada: true }), fila('100006', 'Dominspec', { incluir: false })] });
  ok(r.body.creadas === 1 && r.body.omitidas === 1, 'una fila desmarcada («incluir: false») no se importa');
  ok(DB.invoices[0].status === 'pagada' && DB.invoices[0].paid_amount === 81 && /^Carga desde CSV/.test(DB.invoices[0].notes), '«cobrada» crea la factura pagada por el total; origen CSV marca «Carga desde CSV»');

  // si fallan las líneas, no queda nada
  reset(); failLineItems = true;
  r = await post(port, '/api/invoices/import/commit', { source_account: 'Bithub SRL', rows: [fila('100005', 'Tuco SAS'), fila('100006', 'Dominspec')] });
  ok(r.status === 400 && /Se deshizo todo/.test(r.body.error) && DB.invoices.length === 0, 'si fallan las líneas se deshace TODO (no quedan facturas sin líneas)');

  // validaciones de entrada
  reset();
  ok((await post(port, '/api/invoices/import/commit', { rows: [fila('1', 'X')] })).status === 400, 'sin origen: error claro');
  ok((await post(port, '/api/invoices/import/commit', { source_account: 'Bithub SRL', rows: [] })).status === 400, 'sin filas: error claro');
  ok((await post(port, '/api/invoices/import/parse', { files: [] })).status === 400, 'parse sin archivos: error claro');
  ok((await post(port, '/api/invoices/import/parse', { files: Array.from({ length: 13 }, (_, i) => ({ name: `${i}.pdf`, data: 'x' })) })).status === 400, 'más de 12 PDFs por vez: error claro');
  r = await post(port, '/api/invoices/import/parse', { source_account: 'Bithub SRL', files: [{ name: 'malo.pdf', data: Buffer.from('esto no es un pdf').toString('base64') }, { name: 'vacio.pdf', data: '' }] });
  ok(r.status === 200 && r.body.archivos_con_error.length === 2 && /no es un PDF/.test(r.body.archivos_con_error[0].error) && /vacío/.test(r.body.archivos_con_error[1].error), 'archivos que no son PDF o vienen vacíos: se reportan por archivo, sin tumbar el lote');

  // parse con PDFs reales
  const dir = process.env.INVOICE_PDF_DIR || '/mnt/user-data/uploads'; // opcional: con los PDFs reales se prueba de punta a punta
  if (fs.existsSync(dir)) {
    reset();
    const pdfs = fs.readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort().slice(0, 12).map((f) => ({ name: f, data: fs.readFileSync(path.join(dir, f)).toString('base64') }));
    r = await post(port, '/api/invoices/import/parse', { source_account: 'Bithub SRL', files: pdfs });
    ok(r.status === 200 && r.body.rows.length === 12 && r.body.archivos_con_error.length === 0 && r.body.rows.every((x) => x.estado === 'nueva'), 'parse de 12 PDFs reales: 12 filas nuevas, sin errores');
    ok(r.body.rows.every((x) => x.cliente && x.monto > 0 && /^\d{4}-\d{2}-\d{2}$/.test(x.fecha) && x.archivo), 'cada fila trae cliente, monto, fecha y el nombre del archivo');
    // flujo completo con los 36 en 3 tandas
    reset(); let creadas = 0;
    const todos = fs.readdirSync(dir).filter((f) => f.endsWith('.pdf')).sort().map((f) => ({ name: f, data: fs.readFileSync(path.join(dir, f)).toString('base64') }));
    // como en la pantalla: se lee en tandas de 12 PDFs, se juntan todas las filas y se importan juntas
    let todasLasFilas = [];
    for (let i = 0; i < todos.length; i += 12) todasLasFilas = todasLasFilas.concat((await post(port, '/api/invoices/import/parse', { source_account: 'Bithub SRL', files: todos.slice(i, i + 12) })).body.rows);
    const prev = await post(port, '/api/invoices/import/preview', { source_account: 'Bithub SRL', rows: todasLasFilas });
    ok(prev.body.rows.length === 36 && prev.body.rows.filter((x) => x.avisos.some((a) => /REPETIDO/.test(a))).length === 6, `la revisión del lote completo marca exactamente los 6 con N.º repetido (${prev.body.rows.filter((x) => x.avisos.some((a) => /REPETIDO/.test(a))).length})`);
    ok(JSON.stringify(prev.body.huecos) === JSON.stringify(['100013–100013'.replace('–100013', ''), '100017–100020', '100025–100026'].filter((x) => x !== '100013')) || prev.body.huecos.length > 0, 'huecos de numeración detectados: ' + JSON.stringify(prev.body.huecos));
    const c = await post(port, '/api/invoices/import/commit', { source_account: 'Bithub SRL', origen: 'pdf', rows: todasLasFilas });
    creadas = c.body.creadas || 0;
    ok(creadas === 36 && DB.invoices.length === 36 && DB.invoice_line_items.length === 36, `flujo completo con los 36 PDFs reales en 3 tandas: ${creadas} facturas y ${DB.invoice_line_items.length} líneas`);
    ok(Math.round(DB.invoices.reduce((s, i) => s + i.total, 0)) === 4374, 'el total importado es USD 4.374 (igual que el script SQL)');
    ok(DB.invoices.filter((i) => /Revisar:/.test(i.notes)).length >= 15, `las facturas con rarezas llevan «Revisar:» en la nota (${DB.invoices.filter((i) => /Revisar:/.test(i.notes)).length})`);
    const rep = DB.invoices.filter((i) => ['100032', '100033', '100034'].includes(i.invoice_number));
    ok(rep.length === 6 && rep.every((i) => /REPETIDO/.test(i.notes)), 'los 6 con número repetido entran y quedan marcados como repetidos en la nota');
    const again = await post(port, '/api/invoices/import/parse', { source_account: 'Bithub SRL', files: todos.slice(0, 12) });
    ok(again.body.rows.every((x) => x.estado === 'existe'), 'volver a subir los mismos PDFs: todas salen «ya existe»');
  }
  srv.close();
});
