// Caché en memoria de corta vida, pensada para el CRM (un solo proceso).
//
// Hace dos cosas:
//  1) DEDUPLICA: si llegan N peticiones iguales a la vez (ej. el Dashboard pide lo mismo 3 veces
//     al cargar), solo una consulta va a la base y las demás esperan ese mismo resultado.
//  2) GUARDA el resultado unos segundos, para que pantallas que se abren una tras otra no
//     repitan consultas idénticas.
//
// Seguridad de los datos: TODA escritura (POST/PATCH/PUT/DELETE) vacía la caché completa
// (ver server.js), así que quien guarda un cambio nunca ve datos viejos en la siguiente lectura.
// El TTL es solo el tope por si algo cambia fuera de una petición HTTP (ej. un proceso programado).

const store = new Map(); // key -> { value, expiresAt }
const inflight = new Map(); // key -> Promise
let generation = 0; // sube con cada invalidación para descartar resultados que estaban en vuelo

async function lookup(key, ttlMs, fn) {
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  if (hit) store.delete(key);

  const running = inflight.get(key);
  if (running) return running;

  const myGeneration = generation;
  const p = (async () => {
    try {
      const value = await fn();
      // Si hubo una escritura mientras se consultaba, este resultado puede estar viejo: se
      // entrega a quien lo pidió, pero NO se guarda.
      if (myGeneration === generation && ttlMs > 0) store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// Cada llamador recibe su PROPIA copia: así una ruta que ordene o filtre el resultado en sitio
// (ej. pipelines) no altera lo que ven las demás peticiones.
async function memo(key, ttlMs, fn) {
  return structuredClone(await lookup(key, ttlMs, fn));
}

function clearAll() {
  generation++;
  store.clear();
  inflight.clear();
}

function size() {
  return store.size;
}

module.exports = { memo, clearAll, size };
