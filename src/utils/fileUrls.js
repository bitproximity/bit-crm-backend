// Enlaces a archivos adjuntos (tratos, documentos). Antes eran enlaces PÚBLICOS permanentes: quien recibiera uno lo conservaba para siempre.
// Ahora se firman y vencen en 1 hora (la pantalla pide la lista cada vez que se abre). Si el depósito sigue siendo público, o la firma
// falla, se cae al enlace público para no romper la descarga.
const TTL_SECONDS = 60 * 60;

async function fileUrls(supabase, bucket, paths) {
  const out = {};
  const list = [...new Set((paths || []).filter(Boolean))];
  if (list.length === 0) return out;
  try {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrls(list, TTL_SECONDS);
    if (!error && Array.isArray(data)) data.forEach((d) => { if (d && d.signedUrl && d.path) out[d.path] = d.signedUrl; });
  } catch (e) { /* se usa el enlace público */ }
  for (const p of list) if (!out[p]) out[p] = supabase.storage.from(bucket).getPublicUrl(p).data.publicUrl;
  return out;
}

module.exports = { fileUrls, TTL_SECONDS };
