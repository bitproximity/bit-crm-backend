// Importar facturas desde PDF o CSV al módulo de Facturación.
//   POST /api/invoices/import/parse    { source_account, files:[{name, data(base64)}] } → filas leídas + revisión del lote
//   POST /api/invoices/import/preview  { source_account, rows } → revisión del lote (para CSV y para filas editadas)
//   POST /api/invoices/import/commit   { source_account, origen:'pdf'|'csv', rows } → crea las facturas nuevas
// Nada se corrige en silencio: lo raro del documento queda en `avisos` y se guarda en la nota como «Revisar:».
// Idempotente: una factura con el mismo origen + número + cliente que ya existe se omite, nunca se duplica.
const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { requirePage } = require('../middleware/pagePermissions');
const { logAudit } = require('../utils/audit');
const { canonicalAccountName } = require('../utils/accountNames');
const { parseInvoiceText, revisarCampos } = require('../utils/invoiceParser');

const router = express.Router();
router.use(requireAuth);
router.use(requirePage('facturacion'));

const MAX_FILES = 12;
const MAX_FILE_BYTES = 6 * 1024 * 1024;
const MAX_ROWS = 400;
// Avisos que SOLO el lector del PDF puede producir (no se pueden recalcular desde los campos). Los demás se recalculan
// siempre: así, si la persona corrige una celda, no se arrastran avisos viejos.
const AVISO_SOLO_DEL_LECTOR = /un cero de más/;
const CURRENCIES = ['USD', 'COP', 'MXN', 'PYG', 'DOP', 'EUR'];

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const LEGAL = /\b(sas|srl|sa|s a|s r l|s a s|ltda|llc|eas|inc|corp|sociedad|de cv|s a de c v)\b/g;
const core = (s) => norm(s).replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();
const key = (numero, cliente) => `${String(numero).trim()}|${norm(cliente)}`;

// Limpia y valida una fila que viene del cliente. Devuelve { row, errores }.
function cleanRow(raw, index) {
  const errores = [];
  const row = {
    n: index,
    archivo: raw.archivo ? String(raw.archivo).slice(0, 200) : null,
    numero: String(raw.numero ?? '').trim().slice(0, 40),
    numero_impreso: raw.numero_impreso ? String(raw.numero_impreso).trim().slice(0, 40) : null,
    cliente: String(raw.cliente ?? '').trim().slice(0, 200),
    rnc: raw.rnc ? String(raw.rnc).trim().slice(0, 30) : null,
    ncf: raw.ncf ? String(raw.ncf).trim().slice(0, 40) : null,
    monto: Number(raw.monto),
    moneda: CURRENCIES.includes(String(raw.moneda || 'USD').toUpperCase()) ? String(raw.moneda || 'USD').toUpperCase() : 'USD',
    fecha: String(raw.fecha ?? '').slice(0, 10),
    servicio: raw.servicio ? String(raw.servicio).trim().slice(0, 80) : null,
    descripcion: raw.descripcion ? String(raw.descripcion).trim().slice(0, 300) : null,
    cantidad: Number(raw.cantidad) > 0 ? Number(raw.cantidad) : 1,
    precio_unitario: raw.precio_unitario != null && raw.precio_unitario !== '' ? Number(raw.precio_unitario) : null,
    cobrada: raw.cobrada === true,
    incluir: raw.incluir !== false,
    avisos_origen: Array.isArray(raw.avisos) ? raw.avisos.map((a) => String(a).slice(0, 300)).filter((a) => AVISO_SOLO_DEL_LECTOR.test(a)) : [],
  };
  if (!row.numero) errores.push('falta el N.º de factura');
  if (!row.cliente) errores.push('falta el cliente');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.fecha) || Number.isNaN(Date.parse(row.fecha))) errores.push('la fecha no es válida (usa AAAA-MM-DD)');
  if (!Number.isFinite(row.monto) || row.monto <= 0) errores.push('el total debe ser mayor a 0');
  if (row.precio_unitario != null && !Number.isFinite(row.precio_unitario)) row.precio_unitario = null;
  return { row, errores };
}

// Compacta [100017,100018,100019,100025] → ['100017–100019','100025']
function compactRanges(nums) {
  const out = [];
  let start = null; let prev = null;
  for (const n of nums) {
    if (start === null) { start = n; prev = n; } else if (n === prev + 1) { prev = n; } else { out.push(start === prev ? String(start) : `${start}–${prev}`); start = n; prev = n; }
  }
  if (start !== null) out.push(start === prev ? String(start) : `${start}–${prev}`);
  return out;
}

async function annotate(sourceAccount, rawRows) {
  const cleaned = rawRows.slice(0, MAX_ROWS).map((r, i) => cleanRow(r, i));
  const rows = cleaned.map(({ row, errores }) => ({ ...row, errores, avisos: [], estado: errores.length ? 'error' : 'nueva' }));

  // ¿Ya existen? (mismo origen + número + cliente)
  const numeros = [...new Set(rows.map((r) => r.numero).filter(Boolean))];
  let existentes = [];
  if (numeros.length) {
    const { data } = await supabase.from('invoices').select('invoice_number, client_name').eq('source_account', sourceAccount).in('invoice_number', numeros);
    existentes = data || [];
  }
  const existeKey = new Set(existentes.map((e) => key(e.invoice_number, e.client_name)));
  const numeroUsadoPor = {};
  for (const e of existentes) (numeroUsadoPor[e.invoice_number] ||= []).push(e.client_name);

  const vistos = new Set();
  const porNumero = {}; const porNcf = {};
  rows.forEach((r) => { if (r.numero) (porNumero[r.numero] ||= []).push(r); if (r.ncf) (porNcf[r.ncf] ||= []).push(r); });

  for (const r of rows) {
    if (r.estado === 'error') continue;
    const k = key(r.numero, r.cliente);
    if (existeKey.has(k)) { r.estado = 'existe'; r.avisos.push('ya está cargada en Facturación; se omite'); continue; }
    if (vistos.has(k)) { r.estado = 'duplicada'; r.avisos.push('repetida en este mismo lote (mismo número y cliente); se omite'); continue; }
    vistos.add(k);

    // Revisiones propias de los campos (NCF, mes de servicio vs fecha, total). El corrector del N.º ya lo aplicó el lector.
    const base = revisarCampos({ ...r, numero_impreso: null });
    for (const a of [...r.avisos_origen, ...base]) if (!r.avisos.includes(a)) r.avisos.push(a);

    const otros = (porNumero[r.numero] || []).filter((o) => o !== r && o.estado !== 'error' && key(o.numero, o.cliente) !== k);
    if (otros.length) r.avisos.push(`N.º REPETIDO en este lote: también lo usa la factura a ${otros.map((o) => `${o.cliente} (${o.fecha.split('-').reverse().join('/')})`).join(', ')}`);
    const otrosNcf = (porNcf[r.ncf] || []).filter((o) => o !== r && o.estado !== 'error' && key(o.numero, o.cliente) !== k);
    if (r.ncf && otrosNcf.length) r.avisos.push(`NCF REPETIDO en este lote: ${r.ncf} también está en la factura a ${otrosNcf.map((o) => o.cliente).join(', ')}`);
    const usadoPorOtro = (numeroUsadoPor[r.numero] || []).filter((c) => norm(c) !== norm(r.cliente));
    if (usadoPorOtro.length) r.avisos.push(`ese N.º ya existe en Facturación para ${usadoPorOtro.join(', ')}`);
  }

  // Huecos en la numeración (entre el menor y el mayor número de este lote, contando lo ya cargado)
  const numericos = [...new Set([...rows.filter((r) => r.estado !== 'error').map((r) => r.numero), ...existentes.map((e) => e.invoice_number)].filter((n) => /^\d{4,9}$/.test(n)).map(Number))].sort((a, b) => a - b);
  const faltan = [];
  if (numericos.length > 1) {
    const set = new Set(numericos);
    for (let n = numericos[0]; n <= numericos[numericos.length - 1] && faltan.length < 400; n++) if (!set.has(n)) faltan.push(n);
  }
  return { rows, huecos: compactRanges(faltan) };
}

// Empresa del CRM para un cliente: solo si hay UNA coincidencia clara (igual o que empiece por el nombre sin «SAS/SRL…»)
async function matchCompany(cliente) {
  const c = core(cliente);
  if (c.length < 3) return null;
  const { data } = await supabase.from('companies').select('id, name').ilike('name', `%${c.split(' ')[0]}%`).limit(25);
  const cands = (data || []).filter((co) => { const n = core(co.name); return n === c || n.startsWith(`${c} `) || c.startsWith(`${n} `); });
  return cands.length === 1 ? cands[0] : null;
}

// ── Leer PDFs ────────────────────────────────────────────────────────────────
router.post('/parse', async (req, res) => {
  const sourceAccount = canonicalAccountName(req.body.source_account || 'Bithub SRL');
  const files = Array.isArray(req.body.files) ? req.body.files : [];
  if (!files.length) return res.status(400).json({ error: 'No llegó ningún archivo.' });
  if (files.length > MAX_FILES) return res.status(400).json({ error: `Máximo ${MAX_FILES} PDFs por vez.` });
  let pdf;
  try { pdf = require('pdf-parse/lib/pdf-parse.js'); } catch (e) { return res.status(500).json({ error: 'El lector de PDF no está instalado en el servidor.' }); }

  const rows = []; const errores = [];
  for (const f of files) {
    const name = String(f.name || 'archivo.pdf').slice(0, 200);
    try {
      const buf = Buffer.from(String(f.data || ''), 'base64');
      if (!buf.length) throw new Error('el archivo llegó vacío');
      if (buf.length > MAX_FILE_BYTES) throw new Error('pesa más de 6 MB');
      if (buf.slice(0, 4).toString() !== '%PDF') throw new Error('no es un PDF');
      const parsed = parseInvoiceText((await pdf(buf)).text);
      if (!parsed.ok) throw new Error(parsed.error);
      rows.push({ archivo: name, ...parsed });
    } catch (err) {
      errores.push({ archivo: name, error: err.message || 'no se pudo leer' });
    }
  }
  const out = await annotate(sourceAccount, rows);
  res.json({ source_account: sourceAccount, ...out, archivos_con_error: errores });
});

// ── Revisar un lote (CSV o filas editadas) ───────────────────────────────────
router.post('/preview', async (req, res) => {
  const sourceAccount = canonicalAccountName(req.body.source_account || 'Bithub SRL');
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'No hay filas para revisar.' });
  res.json({ source_account: sourceAccount, ...(await annotate(sourceAccount, rows)) });
});

// ── Importar ─────────────────────────────────────────────────────────────────
router.post('/commit', async (req, res) => {
  const sourceAccount = canonicalAccountName(req.body.source_account || '');
  if (!sourceAccount) return res.status(400).json({ error: 'Falta el origen de las facturas («Empresa que facturó»).' });
  const rawRows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rawRows.length) return res.status(400).json({ error: 'No hay filas para importar.' });
  const marca = req.body.origen === 'csv' ? 'Carga desde CSV' : 'Carga desde PDF';

  const { rows } = await annotate(sourceAccount, rawRows);
  const aImportar = rows.filter((r) => r.estado === 'nueva' && r.incluir);
  const omitidas = rows.length - aImportar.length;
  if (!aImportar.length) return res.json({ creadas: 0, omitidas, mensaje: 'No había facturas nuevas para importar.' });

  // Producto del catálogo por el nombre de la línea (ej. «Arrendamiento de Software Musical Bit-Music» → «Bit Music»)
  const { data: products } = await supabase.from('products').select('id, name, active');
  const catalogo = (products || []).filter((p) => p.active !== false).map((p) => ({ id: p.id, n: norm(p.name) })).sort((a, b) => b.n.length - a.n.length);
  const productoPara = (desc) => { const d = norm(desc); return d ? (catalogo.find((p) => p.n && d.includes(p.n)) || {}).id || null : null; };

  const empresaCache = {};
  const invoiceRows = [];
  for (const r of aImportar) {
    if (!(r.cliente in empresaCache)) empresaCache[r.cliente] = await matchCompany(r.cliente);
    const empresa = empresaCache[r.cliente];
    const partes = [marca];
    if (r.ncf) partes.push(`NCF ${r.ncf}`);
    if (r.rnc) partes.push(`RNC ${r.rnc}`);
    if (r.servicio) partes.push(`Servicio (según el documento): ${r.servicio}`);
    const nota = partes.join(' · ') + (r.avisos.length ? ` · Revisar: ${r.avisos.join('; ')}` : '');
    invoiceRows.push({
      invoice_number: r.numero, company_id: empresa ? empresa.id : null, currency: r.moneda,
      subtotal: r.monto, tax: 0, total: r.monto, paid_amount: r.cobrada ? r.monto : 0, status: r.cobrada ? 'pagada' : 'pendiente',
      issue_date: r.fecha, due_date: null, notes: nota.slice(0, 2000), source_account: sourceAccount, client_name: r.cliente,
      created_by: req.teamMember.id,
    });
  }

  const { data: creadas, error } = await supabase.from('invoices').insert(invoiceRows).select('id, invoice_number, client_name');
  if (error) return res.status(400).json({ error: `No se pudieron crear las facturas: ${error.message}. No se creó ninguna.` });

  const porClave = new Map(aImportar.map((r) => [key(r.numero, r.cliente), r]));
  const lineas = creadas.map((inv) => {
    const r = porClave.get(key(inv.invoice_number, inv.client_name));
    return { invoice_id: inv.id, product_id: productoPara(r.descripcion), description: r.descripcion || `Factura ${r.numero}`, quantity: r.cantidad, unit_price: r.precio_unitario != null ? r.precio_unitario : r.monto };
  });
  const { error: liError } = await supabase.from('invoice_line_items').insert(lineas);
  if (liError) {
    // Deshacer: mejor ninguna factura que facturas sin sus líneas
    await supabase.from('invoices').delete().in('id', creadas.map((c) => c.id));
    return res.status(400).json({ error: `No se pudieron crear las líneas: ${liError.message}. Se deshizo todo; no se creó ninguna factura.` });
  }

  await Promise.all(creadas.map((c) => logAudit('invoice', c.id, 'created', req.teamMember.id)));
  res.status(201).json({ creadas: creadas.length, omitidas, con_empresa: invoiceRows.filter((x) => x.company_id).length, total: invoiceRows.reduce((s, x) => s + x.total, 0) });
});

module.exports = router;
module.exports._test = { annotate, cleanRow, compactRanges, core, matchCompany };
