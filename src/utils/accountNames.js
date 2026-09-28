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
  'Diana Sánchez',
  'Mario Ramos',
  'Bithub SRL',
  'Bit Paraguay EAS',
  'Bit México',
];

// Compara sin mayúsculas, sin tildes y sin espacios de más: "Diana Sanchez", "DIANA SÁNCHEZ" y
// "diana sánchez" son la misma empresa. (La variable de Railway de Facturero Móvil dice
// "Diana Sanchez" sin tilde, y el desplegable de Facturación dice "Diana Sánchez": eran
// dos filas distintas en "Facturado por empresa".)
const normalize = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

function canonicalAccountName(name) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ');
  const found = KNOWN_ACCOUNT_NAMES.find((k) => normalize(k) === normalize(clean));
  return found || clean;
}

module.exports = { canonicalAccountName, KNOWN_ACCOUNT_NAMES };
