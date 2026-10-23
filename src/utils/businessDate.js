// «Hoy» y «este mes» en la zona horaria del NEGOCIO, no la del servidor.
// Railway corre en UTC: entre las 7 p. m. y la medianoche en Panamá (UTC-5) el servidor ya vive en el día
// siguiente, así que `new Date().toISOString().slice(0, 10)` guardaba la fecha de mañana (facturas, proyectos,
// reuniones realizadas), marcaba como vencida una factura que vence hoy, y movía al mes siguiente lo que pasaba
// el último día del mes por la noche. Panamá, Colombia, Ecuador y Perú comparten UTC-5 todo el año;
// se puede cambiar con la variable BUSINESS_TZ en Railway.
const BUSINESS_TZ = process.env.BUSINESS_TZ || 'America/Panama';

const formatterFor = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }); // → AAAA-MM-DD

// Fecha calendario (AAAA-MM-DD) de un instante, vista desde la zona del negocio.
function dateInTz(value = new Date(), tz = BUSINESS_TZ) {
  return formatterFor(tz).format(value instanceof Date ? value : new Date(value));
}
const todayInTz = (tz = BUSINESS_TZ) => dateInTz(new Date(), tz);
const monthInTz = (tz = BUSINESS_TZ) => todayInTz(tz).slice(0, 7);

module.exports = { BUSINESS_TZ, dateInTz, todayInTz, monthInTz };
