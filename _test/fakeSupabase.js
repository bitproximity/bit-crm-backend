// Base simulada en memoria para las pruebas: imita lo justo de supabase-js (select/insert/update/upsert/delete con filtros,
// order/range para fetchAll) y deja que cada prueba decida qué usuario hace la petición con la cabecera x-role.
const Module = require('module');

function createFakeDb(seed = {}) {
  const db = { audit_log: [], notifications: [], ...JSON.parse(JSON.stringify(seed)) };
  let seq = 0;
  const failTables = new Set();

  function Q(table) {
    const st = { f: [], op: 'select', payload: null, opts: null, range: null, single: false, limit: null };
    const a = {
      select() { return a; }, order() { return a; }, limit(n) { st.limit = n; return a; },
      range(from, to) { st.range = [from, to]; return a; }, single() { st.single = true; return a; }, maybeSingle() { st.single = true; return a; },
      eq(c, v) { st.f.push((r) => r[c] === v); return a; }, neq(c, v) { st.f.push((r) => r[c] !== v); return a; },
      in(c, vs) { st.f.push((r) => vs.includes(r[c])); return a; },
      gte(c, v) { st.f.push((r) => r[c] != null && String(r[c]) >= v); return a; }, lt(c, v) { st.f.push((r) => r[c] != null && String(r[c]) < v); return a; },
      not(c, op, v) { if (op === 'is') st.f.push((r) => (v === null ? r[c] != null : r[c] !== v)); return a; },
      ilike(c, v) { const rx = new RegExp('^' + String(v).replace(/[.*+?^${}()|[\]]/g, '\\$&').replace(/\\\\([%_])/g, '\u0001$1').replace(/%/g, '.*').replace(/_/g, '.').replace(/\u0001(.)/g, '$1') + '$', 'i'); st.f.push((r) => rx.test(String(r[c] ?? ''))); return a; },
      or() { return a; }, is(c, v) { st.f.push((r) => (v === null ? r[c] == null : r[c] === v)); return a; },
      insert(p) { st.op = 'insert'; st.payload = p; return a; }, update(p) { st.op = 'update'; st.payload = p; return a; },
      upsert(p, o) { st.op = 'upsert'; st.payload = p; st.opts = o; return a; }, delete() { st.op = 'delete'; return a; },
      then(res) {
        if (failTables.has(table)) return res({ data: null, error: { message: `fallo simulado en ${table}` } });
        const t = (db[table] = db[table] || []);
        const match = (r) => st.f.every((fn) => fn(r));
        const out = (rows) => res({ data: st.single ? (rows[0] ?? null) : rows, error: null });
        if (st.op === 'insert') {
          const rows = [].concat(st.payload).map((r) => ({ id: `${table}-${++seq}`, created_at: new Date().toISOString(), ...r }));
          t.push(...rows); return out(JSON.parse(JSON.stringify(rows)));
        }
        if (st.op === 'update') {
          const hit = t.filter(match); hit.forEach((r) => Object.assign(r, st.payload)); return out(JSON.parse(JSON.stringify(hit)));
        }
        if (st.op === 'upsert') {
          const keys = (st.opts?.onConflict || 'id').split(',');
          const rows = [].concat(st.payload).map((p) => {
            const found = t.find((r) => keys.every((k) => r[k] === p[k]));
            if (found) { Object.assign(found, p); return found; }
            const row = { id: `${table}-${++seq}`, ...p }; t.push(row); return row;
          });
          return out(JSON.parse(JSON.stringify(rows)));
        }
        if (st.op === 'delete') { db[table] = t.filter((r) => !match(r)); return res({ data: null, error: null }); }
        let rows = t.filter(match);
        if (st.range) rows = rows.slice(st.range[0], st.range[1] + 1);
        if (st.limit != null) rows = rows.slice(0, st.limit);
        return out(JSON.parse(JSON.stringify(rows)));
      },
    };
    return a;
  }

  return { db, from: (t) => Q(t), failTables };
}

// Sustituye supabase, la autenticación y la auditoría por versiones de prueba. Hay que llamarlo ANTES de require() de las rutas.
function install(fake, { actorId = 'u-admin' } = {}) {
  const origLoad = Module._load;
  Module._load = function (request) {
    if (/config\/supabase$/.test(request)) return { from: (t) => fake.from(t) };
    if (/middleware\/auth$/.test(request)) return {
      requireAuth: (req, res, next) => { req.teamMember = { id: actorId, role: req.headers['x-role'] || 'admin', blocked_pages: [] }; next(); },
      requireRole: (...roles) => (req, res, next) => (roles.includes(req.teamMember.role) ? next() : res.status(403).json({ error: 'No tienes permisos para esta acción' })),
    };
    if (/middleware\/pagePermissions$/.test(request)) return { requirePage: () => (req, res, next) => next(), roleCanAccess: () => true, isBlockedForUser: () => false, BLOCKABLE_PAGES: ['facturacion', 'agenda_equipo', 'metricas', 'forecast', 'b2b', 'deals', 'productos'] };
    if (/(^|\/)audit$/.test(request)) return { logAudit: async (type, id, action, actor, changes) => { fake.db.audit_log.push({ type, id, action, actor, changes }); } };
    return origLoad.apply(this, arguments);
  };
  return () => { Module._load = origLoad; };
}

module.exports = { createFakeDb, install };
