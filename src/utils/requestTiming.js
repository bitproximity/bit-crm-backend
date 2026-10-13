// Observabilidad: cada respuesta lleva un encabezado estándar `Server-Timing` que dice cuánto tardó
// la validación de sesión, cuánto la base de datos (suma, nº de consultas y la más lenta) y el total.
// Se lee desde el navegador (DevTools → Network → Timing, o por JavaScript) y permite saber DÓNDE se
// va el tiempo de una petición sin adivinar. No expone datos: solo duraciones.
const { AsyncLocalStorage } = require('async_hooks');
const onHeaders = require('on-headers');

const als = new AsyncLocalStorage();
const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6;

// fetch cronometrado para supabase-js: suma el tiempo de cada consulta a la base de ESTA petición.
function timedFetch(input, init) {
  const store = als.getStore();
  if (!store) return fetch(input, init);
  const t0 = process.hrtime.bigint();
  return fetch(input, init).finally(() => {
    const d = ms(t0);
    store.dbMs += d;
    store.dbCalls += 1;
    if (d > store.dbMax) store.dbMax = d;
  });
}

function middleware(req, res, next) {
  const store = { start: process.hrtime.bigint(), authMs: 0, dbMs: 0, dbCalls: 0, dbMax: 0 };
  onHeaders(res, function () {
    const parts = [];
    if (store.authMs) parts.push(`auth;dur=${store.authMs.toFixed(1)}`);
    if (store.dbCalls) parts.push(`db;dur=${store.dbMs.toFixed(1)};desc="${store.dbCalls} consultas, la mas lenta ${store.dbMax.toFixed(0)} ms"`);
    parts.push(`total;dur=${ms(store.start).toFixed(1)}`);
    this.setHeader('Server-Timing', parts.join(', '));
  });
  als.run(store, next);
}

// requireAuth anota cuánto tardó en validar la sesión (0 si salió de la memoria).
function addAuthTime(durMs) {
  const store = als.getStore();
  if (store) store.authMs += durMs;
}

module.exports = { middleware, timedFetch, addAuthTime };
