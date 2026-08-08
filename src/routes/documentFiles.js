const express = require('express');
const multer = require('multer');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const BUCKET = 'document-files';

// GET /api/document-files?document_id=
router.get('/', async (req, res) => {
  const { document_id } = req.query;
  if (!document_id) return res.status(400).json({ error: 'Falta document_id' });

  const { data, error } = await supabase
    .from('document_files')
    .select('*, team_members(full_name)')
    .eq('document_id', document_id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const withUrls = data.map((f) => ({
    ...f,
    url: supabase.storage.from(BUCKET).getPublicUrl(f.file_path).data.publicUrl,
  }));
  res.json(withUrls);
});

// POST /api/document-files  multipart/form-data: file, document_id
router.post('/', upload.single('file'), async (req, res) => {
  const { document_id } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
  if (!document_id) return res.status(400).json({ error: 'Falta document_id' });

  const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${document_id}/${Date.now()}-${safeName}`;

  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, req.file.buffer, {
    contentType: req.file.mimetype,
    upsert: false,
  });
  if (uploadError) return res.status(400).json({ error: uploadError.message });

  const { data, error } = await supabase
    .from('document_files')
    .insert({
      document_id,
      file_name: req.file.originalname,
      file_path: path,
      file_size: req.file.size,
      mime_type: req.file.mimetype,
      uploaded_by: req.teamMember.id,
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ ...data, url: supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl });
});

// DELETE /api/document-files/:id
router.delete('/:id', async (req, res) => {
  const { data: file } = await supabase.from('document_files').select('*').eq('id', req.params.id).single();
  if (!file) return res.status(404).json({ error: 'Archivo no encontrado' });

  await supabase.storage.from(BUCKET).remove([file.file_path]);
  const { error } = await supabase.from('document_files').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });

  res.status(204).send();
});

module.exports = router;
