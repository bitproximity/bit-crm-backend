// Pool propio del reporte. No importa el cliente de servicio del CRM.
// Se crea en la primera petición, nunca al arrancar: sin la variable, el proceso sigue vivo.
const { Pool } = require('pg');
const { assessConfig, safeError } = require('./config');

const pgTypes = require('pg').types;
// date, timestamp, timestamptz: texto de Postgres, no un Date de JS (toISOString corre el día).
const RAW_TEXT_OIDS = new Set([1082, 1114, 1184]);
const types = {
  getTypeParser(oid, format) {
    if ((format || 'text') === 'text' && RAW_TEXT_OIDS.has(oid)) return (value) => value;
    return pgTypes.getTypeParser(oid, format);
  },
};

let pool = null;
let poolUrl = null;

function closePool(old) {
  if (!old) return;
  old.end().catch((err) => console.error('[reporting] al cerrar el pool:', safeError(err)));
}

function getPool() {
  const cfg = assessConfig();
  if (!cfg.ok) {
    if (pool) {
      const previous = pool;
      pool = null;
      poolUrl = null;
      closePool(previous);
    }
    return null;
  }
  if (pool && poolUrl === cfg.url) return pool;
  const previous = pool;
  pool = null;
  poolUrl = cfg.url;
  try {
    // max 2: el rol tiene connection limit 5, y puede haber más de una instancia.
    // sslmode lo decide la URL (el pooler trae sslmode=require, que aquí verifica el certificado).
    pool = new Pool({
      connectionString: cfg.url,
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      query_timeout: 20_000,
      allowExitOnIdle: true,
      application_name: 'bit-crm-reporting',
      types,
    });
    pool.on('error', (err) => console.error('[reporting] conexión inactiva:', safeError(err)));
  } catch (err) {
    pool = null;
    poolUrl = null;
    console.error('[reporting] no se pudo preparar la conexión:', safeError(err));
    closePool(previous);
    return null;
  }
  closePool(previous);
  return pool;
}

async function acquireReportingClient() {
  const current = getPool();
  if (!current) {
    const err = new Error('reporting pool unavailable');
    err.status = 503;
    throw err;
  }
  return current.connect();
}

// Toda lectura va en una transacción READ ONLY con tope de tiempo, aunque el rol
// ya tenga default_transaction_read_only. Un INSERT por un bug falla aquí.
async function withReportingClient(acquire, fn) {
  const client = await acquire();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '20s'");
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[reporting] rollback:', safeError(rollbackErr));
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getPool, acquireReportingClient, withReportingClient, reportingTypes: types };
