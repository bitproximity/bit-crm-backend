// Antes de crear una empresa se busca una existente por nombre normalizado (evita duplicados)
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const { createFakeDb, install } = require('./fakeSupabase');
const fake = createFakeDb({
  companies: [
    { id: 'c1', name: 'MetroBank, S.A.', created_at: '2026-01-01' },
    { id: 'c2', name: 'Grupo Bimbo', created_at: '2026-01-02' },
    { id: 'c3', name: 'Acrópolis Business Mall', created_at: '2026-01-03' },
    { id: 'c4', name: 'Celsia', created_at: '2026-01-04' },
    { id: 'c5', name: 'Banco Unión', created_at: '2026-01-05' },
    { id: 'c6', name: 'Falabella', created_at: '2026-01-06' },
  ],
});
install(fake);
const { findCompanyIdByName } = require('../src/utils/findCompany');
(async () => {
  ok(await findCompanyIdByName('MetroBank') === 'c1', '«MetroBank» encuentra a «MetroBank, S.A.»');
  ok(await findCompanyIdByName('BIMBO') === 'c2', '«BIMBO» encuentra a «Grupo Bimbo»');
  ok(await findCompanyIdByName('acropolis business mall') === 'c3', 'sin tilde encuentra al que tiene tilde');
  ok(await findCompanyIdByName('GRUPO CELSIA') === 'c4', '«GRUPO CELSIA» encuentra a «Celsia»');
  ok(await findCompanyIdByName('  banco   union ') === 'c5', 'espacios de más y sin tilde');
  ok(await findCompanyIdByName('Banco Delta') === null && await findCompanyIdByName('Viajes Falabella') === null, 'una empresa distinta NO coincide (no fusiona de más)');
  ok(await findCompanyIdByName('') === null && await findCompanyIdByName('SA') === null, 'nombre vacío o demasiado corto: no busca');
})();
