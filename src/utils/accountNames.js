// Nombres canónicos de "Empresa que facturó". Las cuentas sincronizadas toman su nombre de
// variables de entorno de Railway (ALEGRA_ACCOUNT_NAME_2, etc.), y un cambio de mayúsculas
// ahí ("BIT COLOMBIA SAS" vs "Bit Colombia SAS") partía el mismo nombre en dos filas en
// Facturación ("Facturado por empresa"). Acá se normaliza contra la lista oficial, sin
// importar mayúsculas/minúsculas ni espacios de más. Mantener en sync con SOURCE_ACCOUNTS
// de frontend/src/pages/Invoicing.jsx.
const KNOWN_ACCOUNT_NAMES = [
  'Bit Colombia SAS',
  'BitProximity LLC',
  'Mario Colombia',
  'Mario Ramos',
  'Bithub SRL',
  'Bit Paraguay EAS',
  'Bit México',
];

function canonicalAccountName(name) {
  const clean = String(name || '').trim();
  const found = KNOWN_ACCOUNT_NAMES.find((k) => k.toLowerCase() === clean.toLowerCase());
  return found || clean;
}

module.exports = { canonicalAccountName, KNOWN_ACCOUNT_NAMES };
