// Metas de reuniones por persona (Bit Prospect): atribución, avance del mes, permisos y guardado en bloque.
const Module = require('module'); const path = require('path'); const http = require('http');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

// ── base simulada en memoria ──────────────────────────────────────────────────────────────────────
const SOFIA = 'm-sofia'; const ANA = 'm-ana'; const ANDREA = 'm-andrea'; const DIEGO = 'm-diego'; const MARIO = 'm-mario'; const MARTINA = 'm-martina'; const LAURA = 'm-laura';
const db = {
  team_members: [
    { id: SOFIA, full_name: 'Sofía Florido', active: true }, { id: ANA, full_name: 'Ana Gabriela Espinel', active: true },
    { id: ANDREA, full_name: 'Andrea Calderón', active: true }, { id: DIEGO, full_name: 'Diego Molina', active: true }, { id: MARIO, full_name: 'Mario Ramos', active: true },
    { id: MARTINA, full_name: 'Martina Villacreses', active: true }, { id: LAURA, full_name: 'Laura Gómez', active: true },
    { id: 'm-viejo', full_name: 'Persona Inactiva', active: false },
  ],
  sales_quotas: [], audit_log: [],
  b2b_records: [
    // octubre 2026
    { id: 'r1', executive: 'Sofia', created_by: MARIO, meeting_date: '2026-10-05', realized_date: '2026-10-05T15:00:00+00:00', companies: { name: 'Periferia' } },
    { id: 'r2', executive: 'Sofía Florido', created_by: MARIO, meeting_date: '2026-10-12', realized_date: null, companies: { name: 'Periferia' } },
    { id: 'r3', executive: 'ana gabriela', created_by: MARIO, meeting_date: '2026-10-20', realized_date: '2026-10-21T10:00:00+00:00', companies: { name: 'Agape' } },
    { id: 'r4', executive: '', created_by: ANDREA, meeting_date: '2026-10-03', realized_date: null, companies: { name: 'Agape' } },       // sin «Ejecutivo»: cuenta quien lo cargó
    { id: 'r5', executive: 'Carolina', created_by: MARIO, meeting_date: '2026-10-08', realized_date: null, companies: { name: 'Periferia' } }, // todavía sin usuario en el CRM
    { id: 'r6', executive: 'Carolina', created_by: MARIO, meeting_date: '2026-10-09', realized_date: '2026-10-10T09:00:00+00:00', companies: { name: 'Periferia' } },
    { id: 'r7', executive: 'Sofia', created_by: MARIO, meeting_date: '2026-09-30', realized_date: '2026-10-02T09:00:00+00:00', companies: { name: 'Agape' } }, // programada en septiembre, realizada en octubre
    // reuniones de personas que NO son del equipo de prospección: se ignoran sin avisar
    { id: 'r10', executive: 'Mario Ramos', created_by: MARIO, meeting_date: '2026-10-14', realized_date: null, companies: { name: 'Agape' } },
    { id: 'r11', executive: 'martina', created_by: MARIO, meeting_date: '2026-10-15', realized_date: null, companies: { name: 'Agape' } },
    // sin «Ejecutivo» y cargada por alguien fuera del equipo: no es de nadie, y SÍ se avisa
    { id: 'r12', executive: '', created_by: MARIO, meeting_date: '2026-10-16', realized_date: null, companies: { name: 'Agape' } },
    // otros meses: no deben contarse en octubre
    { id: 'r8', executive: 'Sofia', created_by: MARIO, meeting_date: '2026-11-02', realized_date: null, companies: { name: 'Agape' } },
    { id: 'r9', executive: 'Sofia', created_by: MARIO, meeting_date: '2026-08-15', realized_date: null, companies: { name: 'Agape' } },
  ],
};
let seq = 0; const failTables = new Set(); const onConflictSeen = [];
function Q(table) {
  const st = { f: [], op: 'select', payload: null, opts: null, range: null, single: false };
  const a = {
    select() { return a; }, order() { return a; }, range(from, to) { st.range = [from, to]; return a; }, single() { st.single = true; return a; },
    eq(c, v) { st.f.push((r) => r[c] === v); return a; }, in(c, vs) { st.f.push((r) => vs.includes(r[c])); return a; },
    gte(c, v) { st.f.push((r) => r[c] != null && String(r[c]) >= v); return a; }, lt(c, v) { st.f.push((r) => r[c] != null && String(r[c]) < v); return a; },
    insert(p) { st.op = 'insert'; st.payload = p; return a; }, upsert(p, o) { st.op = 'upsert'; st.payload = p; st.opts = o; return a; }, delete() { st.op = 'delete'; return a; },
    then(res) {
      if (failTables.has(table)) return res({ data: null, error: { message: `column ${table}.owner_id does not exist` } });
      const t = (db[table] = db[table] || []);
      if (st.op === 'insert') { const rows = [].concat(st.payload).map((r) => ({ id: `${table}-${++seq}`, ...r })); t.push(...rows); return res({ data: rows, error: null }); }
      if (st.op === 'upsert') {
        onConflictSeen.push(st.opts && st.opts.onConflict);
        const keys = (st.opts && st.opts.onConflict || 'id').split(',');
        const out = [].concat(st.payload).map((p) => {
          const hit = t.find((r) => keys.every((k) => r[k] === p[k]));
          if (hit) { Object.assign(hit, p); return hit; }
          const row = { id: `${table}-${++seq}`, ...p }; t.push(row); return row;
        });
        return res({ data: st.single ? out[0] : out, error: null });
      }
      if (st.op === 'delete') { db[table] = t.filter((r) => !st.f.every((fn) => fn(r))); return res({ data: null, error: null }); }
      let rows = t.filter((r) => st.f.every((fn) => fn(r)));
      if (st.range) rows = rows.slice(st.range[0], st.range[1] + 1);
      return res({ data: JSON.parse(JSON.stringify(rows)), error: null });
    },
  };
  return a;
}
const origLoad = Module._load;
Module._load = function (request) {
  if (/config\/supabase$/.test(request)) return { from: (t) => Q(t) };
  if (/middleware\/auth$/.test(request)) return {
    requireAuth: (req, res, next) => { req.teamMember = { id: MARIO, role: req.headers['x-role'] || 'admin', blocked_pages: [] }; next(); },
    requireRole: (...roles) => (req, res, next) => (roles.includes(req.teamMember.role) ? next() : res.status(403).json({ error: 'No tienes permisos para esta acción' })),
  };
  return origLoad.apply(this, arguments);
};

// ── 1) atribución: nombres → personas ────────────────────────────────────────────────────────────
const { normName, buildMemberMatcher, computeProgress, previousMonth } = require('../src/utils/quotaProgress');
const { isExcludedFromBitProspect } = require('../src/utils/bitProspectTeam');
ok(normName('  SOFÍA   Florido ') === 'sofia florido', 'normaliza mayúsculas, tildes y espacios');
const team = db.team_members.filter((m) => m.active && !isExcludedFromBitProspect(m.full_name));
const ignored = db.team_members.filter((m) => m.active && isExcludedFromBitProspect(m.full_name));
ok(['Mario Ramos', 'mario  RAMOS', 'Martina Villacreses', 'Diego Molina', 'Jorge'].every(isExcludedFromBitProspect) && !['Sofía Florido', 'Ana Gabriela Espinel', 'Andrea Calderón', 'Laura Gómez'].some(isExcludedFromBitProspect), 'excluidos: Mario, Martina, Diego y Jorge (sin importar mayúsculas ni espacios); el equipo de prospección no');
const match = buildMemberMatcher(team);
ok(match('Sofia') === SOFIA && match('SOFÍA FLORIDO') === SOFIA, '«Sofia» y el nombre completo reconocen a Sofía Florido');
ok(match('Ana Gabriela') === ANA && match('ana gabriela espinel') === ANA, '«Ana Gabriela» reconoce a Ana Gabriela Espinel');
ok(match('Carolina') === null && match('') === null && match(null) === null, 'un nombre sin usuario (o vacío) no se asigna a nadie');
const dosAna = buildMemberMatcher([{ id: 'a1', full_name: 'Ana Gabriela Espinel' }, { id: 'a2', full_name: 'Ana María Pérez' }]);
ok(dosAna('Ana') === null && dosAna('Ana Gabriela') === 'a1' && dosAna('Ana María') === 'a2', 'si «Ana» sirve para dos personas NO adivina; con el segundo nombre sí');
ok(previousMonth('2026-01') === '2025-12' && previousMonth('2026-10') === '2026-09', 'mes anterior (cruza de año)');

// ── 2) avance del mes ────────────────────────────────────────────────────────────────────────────
const pr = computeProgress([...db.b2b_records, db.b2b_records[0]], team, '2026-10', ignored); // r1 repetida a propósito
ok(pr.members[SOFIA].scheduled === 2 && pr.members[SOFIA].realized === 2, 'Sofía: 2 agendadas (r1, r2) y 2 realizadas en octubre (r1 y r7); la repetida cuenta una vez');
ok(pr.members[ANA].scheduled === 1 && pr.members[ANA].realized === 1, 'Ana Gabriela: 1 agendada y 1 realizada');
ok(pr.members[ANDREA].scheduled === 1, 'Andrea: sin «Ejecutivo» cuenta lo que ella cargó');
ok(pr.members[SOFIA].byClient.Periferia.scheduled === 2 && pr.members[SOFIA].byClient.Agape.realized === 1, 'desglose por cliente');
const carolina = pr.unmatched.find((u) => u.name === 'Carolina');
ok(carolina && carolina.scheduled === 2 && carolina.realized === 1, '«Carolina» (sin usuario) queda aparte con sus 2 agendadas y 1 realizada, no se pierde ni se asigna a otro');
ok(!pr.unmatched.some((u) => /mario|martina/i.test(u.name)), 'las reuniones cuyo «Ejecutivo» es Mario o Martina se ignoran en silencio (no salen como «sin usuario»)');
ok(pr.unmatched.length === 2 && pr.unmatched.some((u) => u.name === '(sin ejecutivo)' && u.scheduled === 1), 'una reunión sin «Ejecutivo» cargada por alguien fuera del equipo sí queda marcada como «(sin ejecutivo)»');
ok(computeProgress(db.b2b_records, team, '2026-10').unmatched.some((u) => /mario/i.test(u.name)), 'sin la lista de ignorados, «Mario Ramos» sí saldría como sin usuario (por eso se le pasa)');
ok(pr.members[SOFIA].scheduled === computeProgress(db.b2b_records, team, '2026-10').members[SOFIA].scheduled, 'contar dos veces la misma fila no cambia el resultado');

// ── 3) servicio ──────────────────────────────────────────────────────────────────────────────────
const express = require(path.resolve(__dirname, '../node_modules/express'));
const app = express(); app.use(express.json()); app.use('/api/quotas', require('../src/routes/quotas'));
const srv = app.listen(0, async () => {
  const call = (method, p, body, role) => new Promise((resolve) => {
    const req = http.request({ port: srv.address().port, path: p, method, headers: { 'Content-Type': 'application/json', ...(role ? { 'x-role': role } : {}) } }, (res) => {
      let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve({ status: res.statusCode, json: s ? JSON.parse(s) : null }));
    });
    if (body) req.write(JSON.stringify(body)); req.end();
  });
  const bulk = (goals, month = '2026-10', role) => call('POST', '/api/quotas/bulk', { month, goals }, role);

  let r = await call('GET', '/api/quotas?month=2026-10');
  ok(r.status === 200 && r.json.month === '2026-10', 'GET devuelve el mes pedido');
  const names = r.json.rows.map((x) => x.full_name);
  ok(!names.includes('Diego Molina') && !names.includes('Persona Inactiva'), 'no aparecen los excluidos de Bit Prospect ni los usuarios inactivos');
  ok(!names.includes('Mario Ramos') && !names.includes('Martina Villacreses'), 'Mario y Martina ya no aparecen en la lista de metas');
  ok(names.join('|') === 'Ana Gabriela Espinel|Andrea Calderón|Laura Gómez|Sofía Florido', 'la lista queda con las personas de prospección (más Carolina cuando tenga usuario)');
  ok(names.join('|') === [...names].sort((a, b) => a.localeCompare(b, 'es')).join('|'), 'ordenado alfabéticamente');
  const sofia = r.json.rows.find((x) => x.team_member_id === SOFIA);
  ok(sofia.scheduled === 2 && sofia.realized === 2 && sofia.actual === 2 && sofia.target === null, 'Sofía: avance correcto y sin meta todavía');
  ok(r.json.unmatched.some((u) => u.name === 'Carolina') && !r.json.unmatched.some((u) => /mario|martina/i.test(u.name)), 'avisa de «Carolina» (sin usuario) pero no de Mario ni de Martina');
  ok(r.json.totals.scheduled === 4 && r.json.totals.realized === 3 && r.json.totals.target === 0, 'totales del equipo (sin contar a Carolina): 4 agendadas, 3 realizadas');

  r = await call('GET', '/api/quotas?month=2026-13'); ok(r.status === 400, 'mes inválido → 400');
  r = await call('GET', '/api/quotas?month=octubre'); ok(r.status === 400, 'mes con formato libre → 400');

  failTables.add('b2b_records');
  r = await call('GET', '/api/quotas?month=2026-10');
  ok(r.status === 500 && /no se pudo calcular el avance/i.test(r.json.error) && /owner_id/.test(r.json.error), 'si la consulta de reuniones falla, responde error visible (antes devolvía ceros en silencio)');
  failTables.delete('b2b_records');

  // permisos y validación del guardado en bloque
  r = await bulk([{ team_member_id: SOFIA, target_meetings: 20 }], '2026-10', 'outbound');
  ok(r.status === 403 && db.sales_quotas.length === 0, 'quien no es admin NO puede asignar metas');
  ok((await bulk([])).status === 400 && (await bulk('x')).status === 400, 'sin metas o con un formato raro → 400');
  ok((await bulk([{ team_member_id: SOFIA, target_meetings: 20 }], '2026-14')).status === 400, 'mes inválido en el guardado → 400');
  for (const malo of [1.5, -2, 1000, 'abc']) ok((await bulk([{ team_member_id: SOFIA, target_meetings: malo }])).status === 400, `meta inválida (${malo}) → 400`);
  ok(db.sales_quotas.length === 0, 'un guardado inválido no deja nada a medias');
  ok((await bulk([{ target_meetings: 5 }])).status === 400, 'una meta sin persona → 400');

  // asignar las metas del equipo de una vez
  r = await bulk([{ team_member_id: SOFIA, target_meetings: 20 }, { team_member_id: ANA, target_meetings: '15' }, { team_member_id: ANDREA, target_meetings: 12 }]);
  ok(r.status === 200 && r.json.saved === 3 && r.json.removed === 0, 'admin asigna metas a tres personas de una vez');
  ok(onConflictSeen.at(-1) === 'team_member_id,month,client_name', 'usa la misma llave que el guardado individual (no duplica)');
  ok(db.sales_quotas.every((q) => q.client_name === '' && q.month === '2026-10') && db.sales_quotas.length === 3, 'quedan como metas generales del mes');
  ok(db.audit_log.filter((x) => x.entity_type === 'sales_quota').length === 3, 'queda registro en auditoría');

  r = await call('GET', '/api/quotas?month=2026-10');
  const por = (id) => r.json.rows.find((x) => x.team_member_id === id);
  ok(por(SOFIA).target === 20 && por(ANA).target === 15 && por(ANDREA).target === 12 && por(LAURA).target === null && por(MARIO) === undefined, 'el GET devuelve cada meta con su avance');
  ok(r.json.totals.target === 47, 'meta total del equipo = 47');

  // sobrescribir y quitar
  r = await bulk([{ team_member_id: SOFIA, target_meetings: 25 }, { team_member_id: ANA, target_meetings: '' }, { team_member_id: ANDREA, target_meetings: 0 }]);
  ok(r.json.saved === 1 && r.json.removed === 2, 'misma persona+mes se sobrescribe; vacío o 0 quita la meta');
  r = await call('GET', '/api/quotas?month=2026-10');
  ok(por(SOFIA).target === 25 && por(ANA).target === null && por(ANDREA).target === null && db.sales_quotas.length === 1, 'sin duplicados: queda solo la meta de Sofía (25)');

  // meta del mes anterior para «copiar»
  await bulk([{ team_member_id: SOFIA, target_meetings: 18 }, { team_member_id: ANA, target_meetings: 9 }], '2026-09');
  r = await call('GET', '/api/quotas?month=2026-10');
  ok(por(SOFIA).previous_target === 18 && por(ANA).previous_target === 9 && por(ANDREA).previous_target === null, 'devuelve la meta del mes anterior de cada persona');
  r = await call('GET', '/api/quotas?month=2026-09');
  ok(por(SOFIA).target === 18 && por(SOFIA).scheduled === 1 && por(SOFIA).realized === 0, 'el mes anterior se consulta con su propia meta y su propio avance (la reunión del 30/09 cuenta en septiembre; se realizó en octubre)');
  r = await call('GET', '/api/quotas?month=2026-09'); ok(r.json.unmatched.length === 0 || r.json.unmatched.every((u) => u.name !== 'Carolina'), 'septiembre no arrastra las reuniones de octubre');

  // guardado individual (compatibilidad)
  r = await call('POST', '/api/quotas', { team_member_id: ANDREA, month: '2026-10', target_meetings: 10 });
  ok(r.status === 201 && db.sales_quotas.some((q) => q.team_member_id === ANDREA && q.target_meetings === 10), 'el guardado individual de siempre sigue funcionando');
  r = await call('POST', '/api/quotas', { team_member_id: ANDREA, month: '2026-10', target_meetings: -3 }); ok(r.status === 400, 'el guardado individual rechaza metas inválidas');
  r = await call('POST', '/api/quotas', { team_member_id: ANDREA, month: '2026-10', target_meetings: 10 }, 'outbound'); ok(r.status === 403, 'el guardado individual también es solo para admin');
  srv.close();
});
