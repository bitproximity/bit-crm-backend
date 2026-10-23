// «Hoy» y «este mes» en la zona del negocio (Panamá, UTC-5), no en UTC.
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const { BUSINESS_TZ, dateInTz, todayInTz, monthInTz } = require('../src/utils/businessDate');

const RealDate = Date;
function at(iso, fn) { // congela «ahora» en un instante UTC
  class Fake extends RealDate { constructor(...a) { if (a.length) super(...a); else super(iso); } static now() { return new RealDate(iso).getTime(); } }
  global.Date = Fake;
  try { return fn(); } finally { global.Date = RealDate; }
}

ok(BUSINESS_TZ === 'America/Panama', 'la zona del negocio por defecto es America/Panama');
// 8:30 p. m. del 22 de octubre en Panamá = 01:30 UTC del 23: el servidor ya vive en «mañana»
ok(new RealDate('2026-10-23T01:30:00Z').toISOString().slice(0, 10) === '2026-10-23', 'el fallo de siempre: con UTC la tarde-noche del 22 se guardaba como el 23');
ok(dateInTz(new RealDate('2026-10-23T01:30:00Z')) === '2026-10-22', 'dateInTz: 8:30 p. m. del 22 en Panamá sigue siendo el 22');
ok(dateInTz(new RealDate('2026-10-23T04:59:59Z')) === '2026-10-22', 'a las 11:59 p. m. sigue siendo el 22');
ok(dateInTz(new RealDate('2026-10-23T05:00:00Z')) === '2026-10-23', 'a medianoche en Panamá empieza el 23');
ok(dateInTz(new RealDate('2026-10-23T12:00:00Z')) === '2026-10-23', 'a mediodía no hay diferencia');
ok(at('2026-10-23T01:30:00Z', () => todayInTz()) === '2026-10-22', 'todayInTz usa «ahora» visto desde Panamá');
// último día del mes por la noche: no debe pasar al mes siguiente
ok(at('2026-11-01T03:00:00Z', () => monthInTz()) === '2026-10' && at('2026-11-01T03:00:00Z', () => todayInTz()) === '2026-10-31', '10 p. m. del 31 de octubre en Panamá sigue siendo octubre (UTC ya decía noviembre)');
ok(at('2026-11-01T05:00:00Z', () => monthInTz()) === '2026-11', 'a medianoche empieza noviembre');
ok(at('2027-01-01T02:00:00Z', () => todayInTz()) === '2026-12-31', 'cruce de año: 9 p. m. del 31/12 en Panamá sigue siendo 2026');
// otra zona
ok(dateInTz(new RealDate('2026-10-23T05:30:00Z'), 'America/Mexico_City') === '2026-10-22', 'se puede pedir otra zona (Ciudad de México, UTC-6)');
ok(/^\d{4}-\d{2}-\d{2}$/.test(dateInTz(new RealDate())), 'el formato es AAAA-MM-DD');
ok(dateInTz(new RealDate(1792800000 * 1000)) === dateInTz('2026-10-23T08:00:00Z'), 'acepta una fecha o un texto/instante (como el created de Stripe, en segundos × 1000)');
