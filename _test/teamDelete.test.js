// Eliminar definitivamente a alguien del equipo: primero el perfil, después la cuenta de Auth.
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const http = require('http'); const path = require('path'); const Module = require('module');
const { createFakeDb, install } = require('./fakeSupabase');
const fake = createFakeDb({ team_members: [
  { id: 'tm-ana', full_name: 'Ana Espinel', active: false, auth_user_id: 'au-ana' },
  { id: 'tm-activo', full_name: 'Activo', active: true, auth_user_id: 'au-act' },
  { id: 'tm-x', full_name: 'X', active: false, auth_user_id: 'au-x' },
] });
install(fake);
const authCalls = []; let authFail = null;
const auth = { admin: {
  // Imita la FK team_members.auth_user_id → auth.users: no deja borrar si el perfil sigue ahí.
  deleteUser: async (uid) => { authCalls.push(['delete', uid]); if (authFail) return { error: { message: authFail } }; if (fake.db.team_members.some((m) => m.auth_user_id === uid)) return { error: { message: 'Database error deleting user' } }; return { error: null }; },
  updateUserById: async (uid, p) => { authCalls.push(['ban', uid, p]); return { error: null }; },
} };
const prev = Module._load;
Module._load = function (request) {
  if (/config\/supabase$/.test(request)) return { from: (t) => fake.from(t), auth };
  if (/utils\/email$/.test(request)) return { sendEmail: async () => ({ ok: true }) };
  if (/rolePermissions$/.test(request)) return { resolvePermissions: async () => ({}) };
  return prev.apply(this, arguments);
};
const express = require(path.resolve(__dirname, '../node_modules/express'));
const app = express(); app.use(express.json()); app.use('/api/team', require('../src/routes/team'));
const srv = app.listen(0, async () => {
  const call = (method, p) => new Promise((r) => { const q = http.request({ port: srv.address().port, path: p, method }, (res) => { let t = ''; res.on('data', (c) => t += c); res.on('end', () => r({ status: res.statusCode, body: t ? JSON.parse(t) : null })); }); q.end(); });
  let r = await call('DELETE', '/api/team/tm-ana/permanent');
  ok(r.status === 204 && !fake.db.team_members.some((m) => m.id === 'tm-ana') && authCalls.some(([k, u]) => k === 'delete' && u === 'au-ana'), 'borra el perfil y luego la cuenta de Auth (ya no falla con «Database error deleting user»)');
  r = await call('DELETE', '/api/team/tm-activo/permanent');
  ok(r.status === 400 && fake.db.team_members.some((m) => m.id === 'tm-activo'), 'a alguien con acceso activo no se le borra');
  authFail = 'otro error'; authCalls.length = 0;
  r = await call('DELETE', '/api/team/tm-x/permanent');
  ok(r.status === 200 && r.body.auth_deleted === false && /bloqueada/.test(r.body.warning) && !fake.db.team_members.some((m) => m.id === 'tm-x') && authCalls.some(([k]) => k === 'ban'), 'si Auth falla igual, el perfil se va y la cuenta queda bloqueada, con aviso');
  srv.close();
});
