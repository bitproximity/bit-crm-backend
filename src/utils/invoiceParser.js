// Lee el TEXTO de una factura en PDF y devuelve sus campos. Solo lee y avisa: nunca corrige en silencio lo que
// parece un error del documento; cada rareza queda en `avisos` para que la persona la vea antes de importar.
//
// Plantillas que reconoce hoy (las dos que usa BITHUB, SRL):
//   · «hoja»  — encabezado «BITHUB, SRL», «Nº de Factura», «Client», «NCF», «Description Units Cost USD Total»
//   · «oscura» — encabezado «BITHUB S.R.L», «N.º de factura», «A la atención de», «Proyecto», «Descripción Cantidad…»
// Otra plantilla devuelve ok:false con el motivo (no inventa datos).

const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };

// «1.234,50» y «216,00» (coma decimal) → número
function parseMoney(s) {
  if (s == null) return null;
  const t = String(s).replace(/[^\d.,]/g, '');
  if (!t) return null;
  let n;
  if (t.includes(',') && t.includes('.')) n = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else if (t.includes(',')) n = /,\d{1,2}$/.test(t) ? t.replace(',', '.') : t.replace(/,/g, '');
  else n = t;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

const pad = (n) => String(n).padStart(2, '0');
function isoDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

// Mes (1-12) y año de «abril 2026», «Septiembre 2026»
function parseServicio(s) {
  const m = /([a-záéíóú]+)\s+(?:de\s+)?(\d{4})/i.exec(s || '');
  if (!m) return null;
  const mes = MESES[m[1].toLowerCase()];
  return mes ? { mes, anio: Number(m[2]) } : null;
}

// ¿Tiene forma de NCF dominicano? B01 + 8 dígitos (también B02, B14…) o e-CF (E31 + 10 dígitos)
function ncfValido(ncf) { return /^B\d{2}\d{8}$/.test(ncf) || /^E\d{2}\d{10}$/.test(ncf); }

// Revisiones de un solo documento
function revisar(r) {
  const avisos = [];

  // N.º con un cero de más: 1000013 en vez de 100013. Solo se corrige si el NCF lo confirma (100000 + secuencia).
  if (r.numero_impreso && /^1000\d{3}$/.test(r.numero_impreso)) {
    const seq = Number((/^B\d{2}(\d{8})$/.exec(r.ncf || '') || [])[1]);
    const candidato = r.numero_impreso.replace(/^1000/, '100');
    if (Number.isFinite(seq) && String(100000 + seq) === candidato) {
      r.numero = candidato;
      avisos.push(`el PDF imprime el N.º de factura como ${r.numero_impreso} (un cero de más); se usó ${candidato}, igual que su NCF`);
    }
  }

  if (r.ncf && !ncfValido(r.ncf)) {
    if (/^B[O]\d{9}$/.test(r.ncf)) avisos.push(`NCF impreso con letra O (${r.ncf}) en vez de B01`);
    else if (/^\d{6,10}$/.test(r.ncf)) avisos.push(`NCF impreso sin el prefijo B01 (${r.ncf})`);
    else avisos.push(`el NCF (${r.ncf}) no tiene el formato esperado`);
  } else if (!r.ncf) {
    avisos.push('no se encontró el NCF');
  }

  // Mes de servicio vs fecha: avisar si el servicio es posterior a la fecha o 2+ meses anterior
  const sv = parseServicio(r.servicio);
  if (sv && r.fecha) {
    const [y, m] = r.fecha.split('-').map(Number);
    const diff = (y * 12 + m) - (sv.anio * 12 + sv.mes);
    if (diff < 0) avisos.push(`la fecha es ${r.fecha.split('-').reverse().join('/')} pero el servicio es de ${r.servicio} (posterior a la fecha)`);
    else if (diff >= 2) avisos.push(`la fecha es ${r.fecha.split('-').reverse().join('/')} pero el texto dice servicio de ${r.servicio}`);
  }

  if (r.monto == null) avisos.push('no se encontró el total');
  return avisos;
}

function parseHoja(text) {
  const t = text.replace(/\r/g, '');
  const r = { plantilla: 'hoja', moneda: 'USD' };

  const f = /Fecha\s*\n\s*(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i.exec(t);
  if (f && MESES[f[2].toLowerCase()]) r.fecha = isoDate(Number(f[3]), MESES[f[2].toLowerCase()], Number(f[1]));

  const n = /N[º°o\.]*\s*de\s*Factura\s*\n\s*(\d{4,9})/i.exec(t);
  if (n) r.numero_impreso = n[1];

  // «Client» → nombre → RNC → NCF
  const c = /Client\s*\n+([^\n]+)\n+\s*(\d{8,11})\s*\n/i.exec(t);
  if (c) { r.cliente = clean(c[1]); r.rnc = c[2]; }

  const ncf = /NCF\s*([A-Z0-9]{6,12}?)\s*\n/.exec(t);
  if (ncf) r.ncf = ncf[1];

  const total = /Total Factura\s*(?:USD|\$)?\s*([\d.,]+)/i.exec(t) || /TOTAL A PAGAR\s*(?:USD|\$)?\s*([\d.,]+)/i.exec(t);
  if (total) r.monto = parseMoney(total[1]);
  if (/USD/.test(t)) r.moneda = 'USD';

  const s = /Correspondiente a ([^\n]+)/i.exec(t);
  if (s) r.servicio = clean(s[1]).toLowerCase();

  // Línea: «Arrendamiento de Software Músical Bit-Music1USD 216,00USD 216,00»
  const l = /\n([^\n]+?)\s*(\d+)\s*USD\s*([\d.,]+)\s*USD\s*([\d.,]+)\s*\n/.exec(t.replace(/Description\s*Units\s*Cost USD\s*Total/i, 'Description\n'));
  if (l && !/Total|Sub/i.test(l[1])) { r.descripcion = clean(l[1]); r.cantidad = Number(l[2]); r.precio_unitario = parseMoney(l[3]); }
  return r;
}

function parseOscura(text) {
  const t = text.replace(/\r/g, '');
  const r = { plantilla: 'oscura', moneda: 'USD' };

  const f = /Fecha:\s*(\d{2})\/(\d{2})\/(\d{4})/.exec(t);
  if (f) r.fecha = isoDate(Number(f[3]), Number(f[2]), Number(f[1])); // dd/mm/aaaa

  // «BITHUB, SRL100039» (el N.º viene pegado al nombre)
  const n = /BITHUB,?\s*SRL\s*(\d{4,9})/i.exec(t);
  if (n) r.numero_impreso = n[1];

  // Cliente: línea(s) tras el N.º hasta la línea de solo dígitos (RNC)
  const afterNum = n ? t.slice(t.indexOf(n[0]) + n[0].length) : t;
  const c = /\n+([^\n]+)\n+\s*(\d{8,11})\b/.exec(afterNum);
  if (c) { r.cliente = clean(c[1]); r.rnc = c[2]; }

  const ncf = /NCF:\s*([A-Z0-9]+?)(?=[A-Z][a-z]|\d{2}\/\d{2}\/\d{4}|\s|$)/.exec(t);
  if (ncf) r.ncf = ncf[1];

  const total = /Subtotal\s*\$?\s*([\d.,]+)/i.exec(t);
  if (total) r.monto = parseMoney(total[1]);

  const s = /Servicio correspondiente al mes de\s*(.+?)\s*Subtotal/i.exec(t);
  if (s) r.servicio = clean(s[1]).toLowerCase();

  // Línea: «Arrendamiento …» + «1$81,00» + «$81,00»
  const l = /Precio total\s*\n+([^\n]+)\n+\s*(\d+)\s*\$\s*([\d.,]+)\s*\n/i.exec(t);
  if (l) { r.descripcion = clean(l[1]); r.cantidad = Number(l[2]); r.precio_unitario = parseMoney(l[3]); }
  return r;
}

function parseInvoiceText(text) {
  const t = String(text || '');
  let r;
  if (/N[º°o\.]*\s*de\s*Factura/i.test(t) && /Client/i.test(t)) r = parseHoja(t);
  else if (/N\.º de factura/i.test(t) || /A la atención de/i.test(t)) r = parseOscura(t);
  else return { ok: false, error: 'No reconozco la plantilla de esta factura (hoy solo leo las de BITHUB, SRL). Usa el CSV o crea la factura a mano.' };

  r.numero = r.numero_impreso || null;
  const faltan = ['numero_impreso', 'cliente', 'fecha', 'monto'].filter((k) => r[k] == null);
  if (faltan.length) return { ok: false, error: `No pude leer: ${faltan.map((k) => ({ numero_impreso: 'el N.º de factura', cliente: 'el cliente', fecha: 'la fecha', monto: 'el total' }[k])).join(', ')}.`, parcial: r };
  r.avisos = revisar(r);
  r.ok = true;
  return r;
}

module.exports = { parseInvoiceText, parseMoney, parseServicio, ncfValido, revisarCampos: revisar };
