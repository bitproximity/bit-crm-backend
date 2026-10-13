const { createClient } = require('@supabase/supabase-js');
const { timedFetch } = require('../utils/requestTiming');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en las variables de entorno.'
  );
}

// Usamos el service_role key porque este backend es el único que habla con
// Supabase (el frontend nunca toca la DB directo). La autorización de cada
// request se valida en middleware/auth.js antes de llegar a las rutas.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  // timedFetch: mide cuánto tarda cada consulta a la base (se ve en el encabezado Server-Timing)
  { auth: { persistSession: false }, global: { fetch: timedFetch } }
);

module.exports = supabase;
