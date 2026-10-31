// Enlaces de descarga de archivos adjuntos (tratos y documentos).
// Los únicos buckets del proyecto son deal-files (migración 005) y document-files
// (migración 006). Esas migraciones los insertaron con public = true y ninguna
// migración posterior toca storage.buckets, pero los depósitos son privados:
// getPublicUrl no autoriza la descarga y no debe devolverse. No hay ningún otro
// bucket en el código ni en las migraciones, así que no queda un depósito público
// al que sí le corresponda un enlace permanente.
// Se firman con createSignedUrls y vencen en 1 hora (la pantalla pide la lista
// cada vez que se abre). Si la firma falla —error de la API, excepción, o un
// archivo sin signedUrl— ese enlace es null.
const TTL_SECONDS = 60 * 60;

async function fileUrls(supabase, bucket, paths) {
  const out = {};
  const list = [...new Set((paths || []).filter(Boolean))];
  if (list.length === 0) return out;
  const wanted = new Set(list);
  try {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrls(list, TTL_SECONDS);
    if (!error && Array.isArray(data)) {
      for (const d of data) {
        if (d && d.path && d.signedUrl && !d.error && wanted.has(d.path)) out[d.path] = d.signedUrl;
      }
    }
  } catch (e) { /* sin firma no hay enlace */ }
  for (const p of list) if (!out[p]) out[p] = null;
  return out;
}

module.exports = { fileUrls, TTL_SECONDS };
