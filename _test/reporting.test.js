// Reporte financiero: autenticación propia, 503 si falta configuración, validación de
// parámetros, y que cada lectura va en una transacción READ ONLY sin armar SQL a mano.
const http = require('http');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const { Client } = require('pg');

const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

const TOKEN = 'test-token-aaa';
const URL_OK = 'postgresql://cfo_readonly.example:hunter2@127.0.0.1:1/postgres';
const root = path.resolve(__dirname, '..');

process.env.REPORTING_DATABASE_URL = URL_OK;
process.env.REPORTING_API_TOKEN = TOKEN;

const { assessConfig, tokenAccepted, safeError } = require('../src/reporting/config');
const { nextMonthStart } = require('../src/reporting/params');
const queries = require('../src/reporting/queries');
const { toCsv } = require('../src/reporting/csv');
const { getPool, reportingTypes } = require('../src/reporting/db');
const { buildRouter, logReportingStatus, REPORTING_RATE_LIMIT_PER_MINUTE } = require('../src/routes/reporting');

function createFake() {
  const state = { calls: [], acquires: 0, error: null };
  const acquire = async () => {
    state.acquires += 1;
    return {
      async query(text, values) {
        const t = String(text).replace(/\s+/g, ' ').trim();
        state.calls.push({ text: t, values });
        if (/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)\b/i.test(t)) return { rows: [] };
        if (state.error) throw state.error;
        if (t.includes('reporting.monthly_revenue_by_country')) {
          return { rows: [{ month: '2026-01-01', country: 'Panamá', currency: 'USD', invoices: 2, invoiced: '10.00', collected: '4.00', outstanding: '6.00' }] };
        }
        if (t.includes('reporting.invoice_payments')) {
          return { rows: [{ paid_at: '2026-10-30 05:00:00+00', invoice_number: 'F-1', cliente: 'Acme, "SA"', company_country: 'Panamá', currency: 'USD', amount: '5.00', method: 'transferencia' }] };
        }
        if (t.includes('reporting.exchange_rates')) {
          return { rows: [{ currency: 'COP', rate_to_usd: '0.00025', updated_at: '2026-10-23 00:00:00+00' }] };
        }
        if (t.includes('reporting.deals')) {
          return { rows: [{ title: '=cmd', company_name: 'Acme', company_country: 'Colombia', product_line: 'WiFi', value: '-12.50', currency: 'USD', closed_at: '2026-10-01', billing_frequency: 'mensual', facturacion: null }] };
        }
        if (t.includes('Sin país')) return { rows: [{ pais: 'Colombia', currency: 'COP', invoice_count: 2, total: '50.00' }] };
        if (t.includes('filter (where due_date')) return { rows: [{ currency: 'COP', invoice_count: 2, total: '50.00', vencido: '10.00' }] };
        if (t.includes('as rango')) {
          return { rows: [{
            invoice_number: 'F-9', source_account: 'Alegra', external_source: 'alegra', cliente: 'Acme', pais: 'Colombia',
            currency: 'COP', total: '20.00', paid_amount: '0', balance_due: '20.00', status: 'pendiente',
            issue_date: '2026-10-01', due_date: '2026-11-15', dias_vencida: 0, rango: 'Por vencer',
          }] };
        }
        return { rows: [] };
      },
      release() { state.calls.push({ text: 'RELEASE' }); },
    };
  };
  return { state, acquire };
}

function listen(router) {
  const app = express();
  app.use('/api/reporting', router);
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function request(port, method, reqPath, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ port, host: '127.0.0.1', method, path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* CSV u HTML */ }
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    req.setTimeout(4000, () => { req.destroy(); resolve({ status: 0, json: null, text: 'timeout', headers: {} }); });
    req.on('error', (err) => resolve({ status: 0, json: null, text: err.message, headers: {} }));
    req.end();
  });
}

const get = (port, reqPath, headers) => request(port, 'GET', reqPath, headers);
const auth = { Authorization: `Bearer ${TOKEN}` };

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function boot(port, extra) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME || '/tmp',
        LANG: process.env.LANG || 'C.UTF-8',
        NODE_ENV: 'test',
        PORT: String(port),
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
        REPORTING_DATABASE_URL: '',
        REPORTING_API_TOKEN: '',
        ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`timeout de arranque\n${buf.slice(-1500)}`)), 8000);
    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) { child.kill('SIGKILL'); reject(err); } else resolve(value);
    }
    child.on('exit', (code) => finish(new Error(`el servidor salió con ${code}\n${buf.slice(-1500)}`)));
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes('corriendo en el puerto')) finish(null, { child, port });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

function stop(child) {
  if (!child || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

function assertReadOnly(calls, label) {
  ok(calls[0] && calls[0].text === 'BEGIN READ ONLY', `${label}: la transacción es READ ONLY`);
  ok(calls.some((c) => c.text === "SET LOCAL statement_timeout = '15s'"), `${label}: limita statement_timeout`);
  const commitAt = calls.findIndex((c) => c.text === 'COMMIT');
  ok(commitAt > 0 && calls[calls.length - 1].text === 'RELEASE' && commitAt < calls.length - 1, `${label}: hace COMMIT y suelta el cliente`);
  ok(calls.filter((c) => c.text.startsWith('select')).every((c) => !String(c.text).includes(TOKEN)), `${label}: el token no entra en el SQL`);
}

(async () => {
  ok(tokenAccepted(`Bearer ${TOKEN}`, TOKEN) === true, 'un Bearer correcto autentica');
  ok(tokenAccepted('bearer ' + TOKEN, TOKEN) === true, 'el esquema Bearer no distingue mayúsculas');
  ok(tokenAccepted('Bearer otro-token', TOKEN) === false, 'un token distinto no autentica');
  ok(tokenAccepted('Bearer abc', 'abcd') === false, 'largos distintos no lanzan y no autentican');
  ok(tokenAccepted(TOKEN, TOKEN) === false, 'sin el esquema Bearer no autentica');
  ok(tokenAccepted('Bearer ' + TOKEN + ' extra', TOKEN) === false, 'basura después del token no autentica');
  ok(nextMonthStart('2026-01') === '2026-02-01' && nextMonthStart('2026-12') === '2027-01-01', 'el mes to es inclusivo: el corte es el día 1 del mes siguiente');

  const csv = toCsv(
    [{ cliente: 'Acme, "SA"', amount: '-12.50', title: '=cmd' }],
    ['cliente', 'amount', 'title']
  );
  ok(csv.split('\n')[0] === 'cliente,amount,title', 'el CSV lleva encabezado');
  ok(csv.includes('"Acme, ""SA"""') && csv.includes('-12.50') && csv.includes("'=cmd"), 'escapa comillas y fórmulas; un importe negativo sigue siendo número');
  ok(toCsv([], ['a', 'b']) === 'a,b\n', 'sin filas igual hay encabezado');

  const reportingSrc = ['config.js', 'params.js', 'queries.js', 'csv.js', 'db.js']
    .map((f) => fs.readFileSync(path.join(root, 'src/reporting', f), 'utf8'))
    .concat(fs.readFileSync(path.join(root, 'src/routes/reporting.js'), 'utf8'))
    .join('\n');
  ok(!/supabase|service_role|SERVICE_ROLE/i.test(reportingSrc), 'el reporte no usa el cliente de servicio ni su clave');
  ok(!/\.query\(\s*`[^`]*\$\{/.test(reportingSrc), 'ninguna consulta se arma interpolando dentro de query()');
  ok(!/select\s+\*/i.test(queries.EXCHANGE_RATES_SQL + queries.RECEIVABLES_SQL + queries.WON_WITHOUT_INVOICE_SQL), 'no hay select *');
  ok(!/email|phone|notes/i.test(queries.RECEIVABLES_SQL + queries.PAYMENTS_SQL + queries.WON_WITHOUT_INVOICE_SQL), 'las consultas no piden correo, teléfono ni notas');
  for (const bucket of ["'Por vencer'", "'1-30'", "'31-60'", "'61-90'", "'90+'"]) {
    ok(queries.RECEIVABLES_SQL.includes(bucket), `la cartera tiene el rango ${bucket}`);
  }
  ok(queries.RECEIVABLES_SQL.includes("'cancelada'") && queries.RECEIVABLES_SQL.includes("'cancelled'") && queries.RECEIVABLES_SQL.includes("'anulada'"), 'la cartera excluye los tres estados anulados');
  ok(queries.TOTALS_BY_CURRENCY_SQL.includes("'anulada'") && queries.TOTALS_BY_COUNTRY_SQL.includes("'cancelled'"), 'los totales usan la misma exclusión');
  ok(queries.WON_WITHOUT_INVOICE_SQL.includes("'ganado'") && queries.WON_WITHOUT_INVOICE_SQL.includes('not exists'), 'ganados sin factura: ganado/won y sin filas en facturas');

  const sqlPath = path.join(root, 'migrations/058_reporting_cfo_readonly.sql');
  const migration = fs.readFileSync(sqlPath, 'utf8');
  ok(migration.includes('REQUIERE REVISIÓN MANUAL'), 'la migración pide revisión manual');
  const passwords = [...migration.matchAll(/password '([^']*)'/gi)].map((m) => m[1]);
  ok(passwords.length === 1 && passwords[0] === 'CAMBIAR_POR_CONTRASEÑA_LARGA', 'la única contraseña del SQL es el marcador');
  ok(migration.includes('set search_path = reporting') && migration.includes('cfo_readonly'), 'el rol queda encerrado en el esquema reporting');
  ok(fs.existsSync(path.join(root, 'migrations/057_fusionar_productos_repetidos.sql')), '058 sigue a la última migración que ya estaba');

  const serverSrc = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
  ok(serverSrc.includes("app.use('/api/reporting'"), 'el servidor monta /api/reporting');
  ok(REPORTING_RATE_LIMIT_PER_MINUTE === 60, 'el límite del reporte es 60 peticiones por minuto');

  const dateClient = new Client({ connectionString: URL_OK, types: reportingTypes });
  ok(dateClient._types.getTypeParser(1082, 'text')('2026-10-31') === '2026-10-31', 'una fecha DATE no se convierte a Date (no se corre el día)');
  ok(dateClient._types.getTypeParser(1184, 'text')('2026-10-31 05:00:00+00') === '2026-10-31 05:00:00+00', 'un timestamptz se devuelve como texto');

  ok(assessConfig({ REPORTING_DATABASE_URL: '', REPORTING_API_TOKEN: TOKEN }).ok === false, 'sin URL no está configurado');
  ok(assessConfig({ REPORTING_DATABASE_URL: URL_OK, REPORTING_API_TOKEN: '  ' }).ok === false, 'sin token no está configurado');
  ok(assessConfig({ REPORTING_DATABASE_URL: 'postgresql://postgres.example:x@127.0.0.1:1/postgres', REPORTING_API_TOKEN: TOKEN }).ok === false, 'un usuario que no es cfo_readonly no está configurado');
  ok(assessConfig({ REPORTING_DATABASE_URL: 'esto no es una url', REPORTING_API_TOKEN: TOKEN }).ok === false, 'una URL ilegible no está configurada');
  ok(assessConfig({ REPORTING_DATABASE_URL: URL_OK, REPORTING_API_TOKEN: TOKEN }).ok === true, 'cfo_readonly.<ref> con token sí está configurado');
  delete process.env.REPORTING_DATABASE_URL;
  delete process.env.REPORTING_API_TOKEN;
  ok(getPool() === null, 'sin variables, getPool no abre nada y no lanza');
  logReportingStatus();
  process.env.REPORTING_DATABASE_URL = URL_OK;
  process.env.REPORTING_API_TOKEN = TOKEN;

  const fake = createFake();
  const noLimit = (req, res, next) => next();
  const { srv, port } = await listen(buildRouter({
    acquire: fake.acquire,
    limiter: noLimit,
    today: () => '2026-10-31',
    timeZone: 'America/Panama',
  }));

  try {
    let r = await get(port, '/api/reporting/receivables');
    ok(r.status === 401 && r.json.error === 'No autorizado.', 'sin Authorization → 401');
    ok(fake.state.acquires === 0, 'un 401 no toca la base');

    r = await get(port, '/api/reporting/receivables', { Authorization: 'Bearer incorrecto' });
    ok(r.status === 401 && r.json.error === 'No autorizado.', 'token incorrecto → 401');

    r = await get(port, '/api/reporting/receivables', { Authorization: 'Basic ' + TOKEN });
    ok(r.status === 401, 'otro esquema (Basic) → 401');

    r = await get(port, `/api/reporting/receivables?token=${TOKEN}`);
    ok(r.status === 401 && fake.state.acquires === 0, 'el token en la query no autentica');

    r = await get(port, `/api/reporting/payments?access_token=${TOKEN}`, auth);
    ok(r.status === 401 && fake.state.acquires === 0, 'aunque el Bearer sea válido, un token en la query se rechaza');

    r = await get(port, '/api/reporting/receivables?api_key=abc', auth);
    ok(r.status === 401, 'api_key en la query se rechaza');

    const savedUrl = process.env.REPORTING_DATABASE_URL;
    const savedToken = process.env.REPORTING_API_TOKEN;
    delete process.env.REPORTING_API_TOKEN;
    r = await get(port, '/api/reporting/receivables', auth);
    ok(r.status === 503 && r.json.error === 'El reporte no está disponible.' && fake.state.acquires === 0, 'sin REPORTING_API_TOKEN → 503 y no consulta');
    process.env.REPORTING_API_TOKEN = savedToken;
    delete process.env.REPORTING_DATABASE_URL;
    r = await get(port, '/api/reporting/exchange-rates', auth);
    ok(r.status === 503 && fake.state.acquires === 0, 'sin REPORTING_DATABASE_URL → 503');
    process.env.REPORTING_DATABASE_URL = 'postgresql://postgres.example:secret@127.0.0.1:1/postgres';
    r = await get(port, '/api/reporting/exchange-rates', auth);
    ok(r.status === 503 && fake.state.acquires === 0, 'si la URL no es cfo_readonly → 503 y no se conecta');
    process.env.REPORTING_DATABASE_URL = '%%%';
    r = await get(port, '/api/reporting/exchange-rates', auth);
    ok(r.status === 503, 'una URL rota → 503, no un 500');
    process.env.REPORTING_DATABASE_URL = savedUrl;

    r = await get(port, '/api/reporting/payments?days=0', auth);
    ok(r.status === 400 && r.json.error === 'days debe ser un entero entre 1 y 366.', 'days=0 → 400');
    r = await get(port, '/api/reporting/payments?days=367', auth);
    ok(r.status === 400, 'days=367 (más que un año) → 400');
    r = await get(port, '/api/reporting/payments?days=-1', auth);
    ok(r.status === 400, 'days negativo → 400');
    r = await get(port, '/api/reporting/payments?days=1.5', auth);
    ok(r.status === 400, 'days con decimal → 400');
    r = await get(port, '/api/reporting/payments?days=1e2', auth);
    ok(r.status === 400, 'days en notación científica → 400');
    r = await get(port, '/api/reporting/payments?days=030', auth);
    ok(r.status === 400, 'days con ceros a la izquierda → 400');
    r = await get(port, '/api/reporting/payments?days=abc', auth);
    ok(r.status === 400, 'days que no es número → 400');
    r = await get(port, '/api/reporting/payments?days=10&days=20', auth);
    ok(r.status === 400, 'days repetido → 400');
    ok(fake.state.acquires === 0, 'ningún days inválido consulta la base');

    r = await get(port, '/api/reporting/monthly-revenue?from=2026-13', auth);
    ok(r.status === 400 && r.json.error === 'from debe ser un mes YYYY-MM.', 'mes 13 → 400');
    r = await get(port, '/api/reporting/monthly-revenue?from=2026-1', auth);
    ok(r.status === 400, 'mes sin cero a la izquierda → 400');
    r = await get(port, '/api/reporting/monthly-revenue?to=no', auth);
    ok(r.status === 400 && r.json.error === 'to debe ser un mes YYYY-MM.', 'to ilegible → 400');
    r = await get(port, '/api/reporting/monthly-revenue?from=2026-05&to=2026-01', auth);
    ok(r.status === 400 && r.json.error === 'from no puede ser posterior a to.', 'from posterior a to → 400');
    r = await get(port, "/api/reporting/monthly-revenue?from=2026-01';drop%20table%20invoices--", auth);
    ok(r.status === 400 && fake.state.acquires === 0, 'un from con SQL no se ejecuta');
    r = await get(port, '/api/reporting/payments?format=xml', auth);
    ok(r.status === 400 && r.json.error === 'format debe ser json o csv.', 'format desconocido → 400');
    r = await get(port, '/api/reporting/payments?format=CSV', auth);
    ok(r.status === 400, 'format distingue mayúsculas');

    r = await request(port, 'POST', '/api/reporting/receivables', auth);
    ok(r.status === 404 && fake.state.acquires === 0, 'no hay escrituras: POST no tiene ruta');

    fake.state.calls = [];
    r = await get(port, '/api/reporting/receivables', auth);
    ok(r.status === 200 && r.json.as_of === '2026-10-31', 'cartera: 200 y fecha de corte');
    ok(r.json.rows[0].rango === 'Por vencer' && r.json.rows[0].balance_due === '20.00', 'cartera: devuelve el rango y el saldo como vino de Postgres');
    ok(r.json.totals_by_currency[0].currency === 'COP' && r.json.totals_by_currency[0].vencido === '10.00', 'cartera: totales por moneda');
    ok(r.json.totals_by_country[0].pais === 'Colombia', 'cartera: totales por país');
    ok(r.headers['cache-control'] === 'no-store', 'la respuesta no se guarda en caché');
    assertReadOnly(fake.state.calls, 'cartera');
    const detail = fake.state.calls.find((c) => c.text.includes('as rango'));
    ok(detail && detail.values[0] === '2026-10-31' && !detail.text.includes('2026-10-31'), 'la fecha de corte va como parámetro, no pegada en el SQL');

    r = await get(port, '/api/reporting/receivables?format=csv', auth);
    ok(r.status === 200 && String(r.headers['content-type']).includes('text/csv'), 'format=csv responde CSV');
    ok(r.text.startsWith(queries.RECEIVABLES_COLUMNS.join(',')) && !r.text.includes('totals_by_currency'), 'el CSV de cartera es el detalle, con encabezado fijo');

    fake.state.calls = [];
    r = await get(port, '/api/reporting/payments', auth);
    ok(r.status === 200 && r.json.days === 30 && r.json.rows[0].cliente === 'Acme, "SA"', 'cobros: 30 días si no se pide otra cosa');
    const pay = fake.state.calls.find((c) => c.text.includes('invoice_payments'));
    ok(pay && pay.values[0] === '2026-10-31' && pay.values[1] === 'America/Panama' && pay.values[2] === 30, 'cobros: hoy, zona y días son parámetros');
    ok(pay.text.includes('$1') && pay.text.includes('$2') && pay.text.includes('$3') && !pay.text.includes('America/Panama'), 'cobros: la zona horaria no se interpola');
    assertReadOnly(fake.state.calls, 'cobros');

    r = await get(port, '/api/reporting/payments?days=366&format=csv', auth);
    ok(r.status === 200 && r.text.includes('"Acme, ""SA"""') && String(r.headers['content-disposition']).includes('cobros.csv'), 'days=366 (el máximo) y CSV con comillas escapadas');
    const payMax = fake.state.calls.filter((c) => c.text.includes('invoice_payments')).pop();
    ok(payMax && payMax.values[2] === 366, 'days=366 llega como número, no como texto armado');

    fake.state.calls = [];
    r = await get(port, '/api/reporting/monthly-revenue?from=2026-01&to=2026-12', auth);
    ok(r.status === 200 && r.json.rows[0].country === 'Panamá' && r.json.from === '2026-01' && r.json.to === '2026-12', 'mensual: filtra y devuelve el rango pedido');
    const monthly = fake.state.calls.find((c) => c.text.includes('monthly_revenue_by_country'));
    ok(monthly && monthly.values[0] === '2026-01-01' && monthly.values[1] === '2027-01-01', 'to=2026-12 incluye diciembre (corte en 2027-01-01)');
    ok(!monthly.text.includes('2026-01-01') && !monthly.text.includes('2027-01-01'), 'los meses no se pegan en el SQL');

    r = await get(port, '/api/reporting/monthly-revenue?from=2026-10', auth);
    const onlyFrom = fake.state.calls.filter((c) => c.text.includes('monthly_revenue_by_country')).pop();
    ok(r.status === 200 && onlyFrom.values[0] === '2026-10-01' && onlyFrom.values[1] === null, 'solo from: sin tope superior');

    r = await get(port, '/api/reporting/won-deals-without-invoice?format=csv', auth);
    ok(r.status === 200 && r.text.includes("'=cmd") && r.text.includes('-12.50'), 'ganados sin factura: CSV, fórmula neutralizada, negativo intacto');

    r = await get(port, '/api/reporting/exchange-rates', auth);
    ok(r.status === 200 && r.json.rows[0].currency === 'COP' && r.json.rows[0].rate_to_usd === '0.00025', 'tasas: moneda y tasa, sin select *');

    fake.state.error = new Error(`permission denied ${URL_OK} token ${TOKEN} password hunter2 relation secret_invoices`);
    fake.state.calls = [];
    const logged = [];
    const origErr = console.error;
    console.error = (...args) => { logged.push(args.join(' ')); };
    r = await get(port, '/api/reporting/exchange-rates', auth);
    console.error = origErr;
    ok(r.status === 500 && r.json.error === 'No se pudo generar el reporte.', 'un fallo de la base es un 500 genérico');
    ok(!r.text.includes('secret_invoices') && !r.text.includes('hunter2') && !r.text.includes(TOKEN) && !r.text.includes('permission denied'), 'el cliente no ve el error de Postgres ni secretos');
    const logText = logged.join('\n');
    ok(logText.includes('secret_invoices') && !logText.includes(TOKEN) && !logText.includes('hunter2') && !logText.includes(URL_OK), 'el log del servidor guarda el fallo y tapa token, contraseña y URL');
    ok(fake.state.calls.some((c) => c.text === 'ROLLBACK') && !fake.state.calls.some((c) => c.text === 'COMMIT'), 'si la consulta falla se hace ROLLBACK, no COMMIT');
    ok(fake.state.calls[fake.state.calls.length - 1].text === 'RELEASE', 'el cliente se suelta aunque falle');
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }

  const limited = createFake();
  const limitedSrv = await listen(buildRouter({
    acquire: limited.acquire,
    limit: 3,
    today: () => '2026-10-31',
    timeZone: 'America/Panama',
  }));
  try {
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await get(limitedSrv.port, '/api/reporting/exchange-rates', auth)).status);
    ok(codes.join() === '200,200,200,429', 'a la cuarta petición en un minuto responde 429');
    const blocked = await get(limitedSrv.port, '/api/reporting/exchange-rates', auth);
    ok(blocked.json.error === 'Demasiadas peticiones. Intenta de nuevo en un minuto.', 'el 429 explica el límite');
    ok(limited.state.acquires === 3, 'lo que pasa el límite no consulta la base');
  } finally {
    await new Promise((resolve) => limitedSrv.srv.close(resolve));
  }

  try {
    const portOff = await freePort();
    const off = await boot(portOff, {});
    try {
      const health = await get(portOff, '/health');
      ok(health.status === 200 && health.json && health.json.ok === true, 'el servidor arranca sin las variables del reporte');
      const rep = await get(portOff, '/api/reporting/receivables');
      ok(rep.status === 503 && rep.json.error === 'El reporte no está disponible.', 'en el proceso real, sin configuración, el reporte responde 503');
      const withToken = await get(portOff, `/api/reporting/payments?token=${TOKEN}`, auth);
      ok(withToken.status === 503, 'sin configuración no se acepta ni un token en la query');
      const healthAgain = await get(portOff, '/health');
      ok(healthAgain.status === 200, 'ese 503 no tumba el proceso');
    } finally {
      await stop(off.child);
    }

    const portOn = await freePort();
    const on = await boot(portOn, { REPORTING_DATABASE_URL: URL_OK, REPORTING_API_TOKEN: TOKEN });
    try {
      const health = await get(portOn, '/health');
      ok(health.status === 200, 'también arranca con la URL del reporte (no se conecta al cargar)');
      const anon = await get(portOn, '/api/reporting/receivables');
      ok(anon.status === 401, 'con la URL puesta, sin Bearer sigue siendo 401');
      const bad = await get(portOn, '/api/reporting/payments?days=9999', auth);
      ok(bad.status === 400, 'days inválido se rechaza antes de intentar la conexión');
      const down = await get(portOn, '/api/reporting/exchange-rates', auth);
      ok(down.status === 500 && down.json.error === 'No se pudo generar el reporte.' && !down.text.includes('ECONNREFUSED') && !down.text.includes('hunter2'), 'si la base no acepta, el cliente ve un 500 genérico');
      const healthAgain = await get(portOn, '/health');
      ok(healthAgain.status === 200, 'un fallo de la base del reporte no tumba el proceso');
    } finally {
      await stop(on.child);
    }
  } catch (err) {
    ok(false, `el servidor no arrancó: ${String(err.message || err).replace(/hunter2/g, '[redacted]').slice(0, 500)}`);
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
