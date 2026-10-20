// Lee los PDFs reales de BITHUB, SRL y compara cada campo con la transcripción manual.
const fs = require('fs'); const path = require('path');
const { parseInvoiceText, parseMoney, parseServicio, ncfValido } = require('../src/utils/invoiceParser');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const FIXTURES = require('./fixtures/invoice-texts.json');   // texto extraído de los 36 PDFs reales (no hace falta tenerlos)
const C = { B: ['Inversiones Blumaro', '130194491'], K: ['Caleya, SAS', '132664086'], T: ['Tuco SAS', '132651405'], D: ['Dominspec', '130414661'] };
const amt = { B: 162, K: 27, T: 216, D: 81 };
// [numero_impreso, cliente, ncf_impreso, fecha, servicio, avisos esperados (fragmentos)]
const E = [];
const add = (n, k, ncf, fecha, serv, av = []) => E.push({ numero_impreso: n, k, ncf, fecha, serv, av });
add('100005', 'B', 'B0100000005', '2026-01-02', 'enero 2026'); add('100006', 'K', 'B0100000006', '2026-01-02', 'enero 2026'); add('100007', 'T', 'B0100000007', '2026-01-02', 'enero 2026'); add('100008', 'D', 'B0100000008', '2026-01-02', 'enero 2026');
add('100009', 'B', 'B0100000009', '2026-02-04', 'enero 2026'); add('100010', 'K', 'B0100000010', '2026-02-04', 'enero 2026'); add('100011', 'T', 'B0100000011', '2026-02-04', 'enero 2026'); add('100012', 'D', 'B0100000012', '2026-02-04', 'enero 2026');
add('1000013', 'B', 'B0100000013', '2026-03-02', 'marzo 2026', ['1000013']); add('100014', 'K', 'B0100000014', '2026-03-02', 'marzo 2026'); add('100015', 'T', 'B0100000015', '2026-03-02', 'marzo 2026'); add('100016', 'D', 'B0100000016', '2026-02-04', 'marzo 2026', ['posterior a la fecha']);
add('1000021', 'B', 'B0100000021', '2026-05-01', 'mayo 2026', ['1000021']); add('100022', 'K', 'B0100000022', '2026-05-01', 'mayo 2026'); add('100023', 'T', 'B0100000023', '2026-05-01', 'mayo 2026'); add('100024', 'D', 'B0100000024', '2026-05-01', 'mayo 2026');
add('100027', 'T', '1000027', '2026-06-01', 'abril 2026', ['sin el prefijo', 'servicio de abril']); add('100028', 'K', '1000028', '2026-06-01', 'abril 2026', ['sin el prefijo', 'servicio de abril']); add('100029', 'B', '1000029', '2026-06-01', 'abril 2026', ['sin el prefijo', 'servicio de abril']); add('100030', 'D', '1000030', '2026-06-01', 'abril 2026', ['sin el prefijo', 'servicio de abril']);
add('100031', 'T', 'BO100000031', '2026-07-01', 'abril 2026', ['letra O', 'servicio de abril']); add('100032', 'K', 'BO100000032', '2026-07-01', 'abril 2026', ['letra O', 'servicio de abril']); add('100033', 'B', 'BO100000033', '2026-07-01', 'abril 2026', ['letra O', 'servicio de abril']); add('100034', 'D', 'BO100000034', '2026-07-01', 'abril 2026', ['letra O', 'servicio de abril']);
add('100032', 'T', 'BO100000032', '2026-08-13', 'agosto 2026', ['letra O']); add('100033', 'K', 'BO100000033', '2026-08-13', 'agosto 2026', ['letra O']); add('100034', 'B', 'BO100000034', '2026-08-13', 'agosto 2026', ['letra O']); add('100035', 'D', 'BO100000035', '2026-08-13', 'agosto 2026', ['letra O']);
add('100036', 'T', 'B0100000036', '2026-09-02', 'septiembre 2026'); add('100037', 'K', 'B0100000037', '2026-09-02', 'septiembre 2026'); add('100038', 'B', 'B0100000038', '2026-09-02', 'septiembre 2026'); add('100039', 'D', 'B0100000039', '2026-09-02', 'septiembre 2026');
add('100040', 'T', 'B0100000040', '2026-10-16', 'septiembre 2026'); add('100041', 'K', 'B0100000041', '2026-10-16', 'septiembre 2026'); add('100042', 'B', 'B0100000042', '2026-10-16', 'septiembre 2026'); add('100043', 'D', 'B0100000043', '2026-10-16', 'septiembre 2026');

(async () => {
  // utilidades
  ok(parseMoney('216,00') === 216 && parseMoney('$1.234,50') === 1234.5 && parseMoney('1,234.50') === 1234.5 && parseMoney('USD 81,00') === 81 && parseMoney('') === null, 'parseMoney: coma decimal, miles con punto, formato inglés y vacío');
  ok(JSON.stringify(parseServicio('Septiembre 2026')) === JSON.stringify({ mes: 9, anio: 2026 }) && parseServicio('algo') === null, 'parseServicio lee mes y año');
  ok(ncfValido('B0100000039') && ncfValido('E310000000001') && !ncfValido('BO100000032') && !ncfValido('1000027'), 'ncfValido: B01+8 dígitos y e-CF sí; letra O y sin prefijo no');
  ok(parseInvoiceText('hola mundo').ok === false && /plantilla/.test(parseInvoiceText('hola mundo').error), 'una plantilla desconocida NO inventa datos: avisa');

  const files = Object.keys(FIXTURES).sort();
  const rows = files.map((f) => ({ f, ...parseInvoiceText(FIXTURES[f]) }));
  ok(files.length === 36, `hay ${files.length} textos de factura (esperados 36)`);
  const bad = rows.filter((r) => !r.ok); ok(bad.length === 0, `los 36 se leen sin error${bad.length ? ': ' + bad.map((b) => b.f + ' → ' + b.error).join(' | ') : ''}`);
  const key = (n, c, f) => `${n}|${c}|${f}`;
  const got = new Map(rows.filter((r) => r.ok).map((r) => [key(r.numero_impreso, r.cliente, r.fecha), r]));
  ok(got.size === 36, 'los 36 son distintos (número impreso + cliente + fecha), incluidos los 6 de número repetido');
  let missing = [], wrong = [];
  for (const e of E) {
    const [cli, rnc] = C[e.k]; const r = got.get(key(e.numero_impreso, cli, e.fecha));
    if (!r) { missing.push(`${e.numero_impreso} ${cli} ${e.fecha}`); continue; }
    const probs = [];
    if (r.rnc !== rnc) probs.push(`rnc ${r.rnc}`); if (r.ncf !== e.ncf) probs.push(`ncf ${r.ncf}≠${e.ncf}`); if (r.monto !== amt[e.k]) probs.push(`monto ${r.monto}`);
    if (r.servicio !== e.serv) probs.push(`servicio «${r.servicio}»`); if (r.moneda !== 'USD') probs.push('moneda'); if (r.cantidad !== 1 || r.precio_unitario !== amt[e.k]) probs.push(`línea ${r.cantidad}×${r.precio_unitario}`);
    if (!/Arrendamiento de Software M[uú]sic?al Bit[- ]Music/i.test(r.descripcion || '')) probs.push(`descripción «${r.descripcion}»`);
    const av = (r.avisos || []).join(' || ');
    for (const frag of e.av) if (!av.includes(frag)) probs.push(`falta aviso «${frag}»`);
    if (e.av.length === 0 && r.avisos.length) probs.push(`aviso inesperado: ${av}`);
    if (probs.length) wrong.push(`${e.numero_impreso} ${cli}: ${probs.join('; ')}`);
  }
  ok(missing.length === 0, `no falta ninguna factura esperada${missing.length ? ': ' + missing.join(', ') : ''}`);
  ok(wrong.length === 0, `campos exactos en las 36 (cliente, RNC, NCF, monto, fecha, servicio, línea) y avisos correctos${wrong.length ? '\n   ' + wrong.join('\n   ') : ''}`);
  const norm = rows.filter((r) => r.ok && r.numero !== r.numero_impreso).map((r) => `${r.numero_impreso}→${r.numero}`).sort();
  ok(JSON.stringify(norm) === JSON.stringify(['1000013→100013', '1000021→100021']), `solo se normalizan los dos números con cero de más (${norm.join(', ')})`);
  const conAviso = rows.filter((r) => r.ok && r.avisos.length).length;
  ok(conAviso === 15, `15 facturas con aviso, las otras 21 limpias (${conAviso})`);
})();
