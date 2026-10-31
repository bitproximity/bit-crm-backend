// API de solo lectura para el asistente financiero. Montada en /api/reporting.
// Autenticación propia (REPORTING_API_TOKEN) y pool propio (REPORTING_DATABASE_URL).
// Si falta la configuración, 503: el resto del proceso no se entera.
const express = require('express');
const { assessConfig, tokenAccepted, hasQueryCredential, safeError } = require('../reporting/config');
const { parseFormat, parseDays, parseMonthRange } = require('../reporting/params');
const queries = require('../reporting/queries');
const { toCsv } = require('../reporting/csv');
const { acquireReportingClient, withReportingClient } = require('../reporting/db');
const { makeReportingLimiter, REPORTING_RATE_LIMIT_PER_MINUTE } = require('../middleware/rateLimits');
const { todayInTz, BUSINESS_TZ } = require('../utils/businessDate');

const UNAUTHORIZED = { error: 'No autorizado.' };
const UNAVAILABLE = { error: 'El reporte no está disponible.' };
const FAILED = { error: 'No se pudo generar el reporte.' };

function safeTimeZone(tz) {
  return /^[A-Za-z0-9_+/.-]{1,64}$/.test(String(tz || '')) ? tz : 'America/Panama';
}

function handle(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      if (res.headersSent) return next(err);
      const unavailable = err && err.status === 503;
      console.error('[reporting]', req.method, req.path, safeError(err));
      res.status(unavailable ? 503 : 500).json(unavailable ? UNAVAILABLE : FAILED);
    });
  };
}

function send(res, format, filename, payload, columns) {
  if (format === 'csv') {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(toCsv(payload.rows || [], columns));
    return;
  }
  res.json(payload);
}

function buildRouter(options = {}) {
  const acquire = options.acquire || acquireReportingClient;
  const todayOf = options.today || (() => todayInTz());
  const timeZone = options.timeZone || safeTimeZone(BUSINESS_TZ);
  const limiter = options.limiter || makeReportingLimiter(options.limit || REPORTING_RATE_LIMIT_PER_MINUTE);
  const run = (fn) => withReportingClient(acquire, fn);

  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Vary', 'Authorization');
    next();
  });
  router.use(limiter);
  router.use((req, res, next) => {
    const cfg = assessConfig();
    if (!cfg.ok) return res.status(503).json(UNAVAILABLE);
    if (hasQueryCredential(req)) return res.status(401).json(UNAUTHORIZED);
    if (!tokenAccepted(req.headers.authorization, cfg.token)) return res.status(401).json(UNAUTHORIZED);
    next();
  });

  router.get('/receivables', handle(async (req, res) => {
    const format = parseFormat(req.query.format);
    if (!format.ok) return res.status(400).json({ error: format.error });
    const today = todayOf();
    const [rows, totalsByCurrency, totalsByCountry] = await run(async (client) => {
      const detail = await client.query(queries.RECEIVABLES_SQL, [today]);
      const byCurrency = await client.query(queries.TOTALS_BY_CURRENCY_SQL, [today]);
      const byCountry = await client.query(queries.TOTALS_BY_COUNTRY_SQL, [today]);
      return [detail.rows, byCurrency.rows, byCountry.rows];
    });
    send(res, format.format, 'cartera.csv', {
      as_of: today,
      rows,
      totals_by_currency: totalsByCurrency,
      totals_by_country: totalsByCountry,
    }, queries.RECEIVABLES_COLUMNS);
  }));

  router.get('/won-deals-without-invoice', handle(async (req, res) => {
    const format = parseFormat(req.query.format);
    if (!format.ok) return res.status(400).json({ error: format.error });
    const result = await run((client) => client.query(queries.WON_WITHOUT_INVOICE_SQL));
    send(res, format.format, 'ganados_sin_factura.csv', { rows: result.rows }, queries.WON_COLUMNS);
  }));

  router.get('/monthly-revenue', handle(async (req, res) => {
    const format = parseFormat(req.query.format);
    if (!format.ok) return res.status(400).json({ error: format.error });
    const range = parseMonthRange(req.query.from, req.query.to);
    if (!range.ok) return res.status(400).json({ error: range.error });
    const q = queries.monthlyQuery(range);
    const result = await run((client) => client.query(q.text, q.values));
    send(res, format.format, 'mensual_por_pais.csv', {
      from: range.from,
      to: range.to,
      rows: result.rows,
    }, queries.MONTHLY_COLUMNS);
  }));

  router.get('/payments', handle(async (req, res) => {
    const format = parseFormat(req.query.format);
    if (!format.ok) return res.status(400).json({ error: format.error });
    const days = parseDays(req.query.days);
    if (!days.ok) return res.status(400).json({ error: days.error });
    const today = todayOf();
    const q = queries.paymentsQuery({ today, days: days.days, timeZone });
    const result = await run((client) => client.query(q.text, q.values));
    send(res, format.format, 'cobros.csv', { days: days.days, as_of: today, rows: result.rows }, queries.PAYMENT_COLUMNS);
  }));

  router.get('/exchange-rates', handle(async (req, res) => {
    const format = parseFormat(req.query.format);
    if (!format.ok) return res.status(400).json({ error: format.error });
    const result = await run((client) => client.query(queries.EXCHANGE_RATES_SQL));
    send(res, format.format, 'tasas.csv', { rows: result.rows }, queries.RATE_COLUMNS);
  }));

  return router;
}

function logReportingStatus() {
  if (assessConfig().ok) console.log('[reporting] API de solo lectura lista (usuario cfo_readonly).');
  else console.warn('[reporting] API apagada hasta configurar REPORTING_DATABASE_URL (usuario cfo_readonly) y REPORTING_API_TOKEN. Responde 503.');
}

const router = buildRouter();
router.logReportingStatus = logReportingStatus;
module.exports = router;
module.exports.buildRouter = buildRouter;
module.exports.logReportingStatus = logReportingStatus;
module.exports.REPORTING_RATE_LIMIT_PER_MINUTE = REPORTING_RATE_LIMIT_PER_MINUTE;
