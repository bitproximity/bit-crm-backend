const express = require('express');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/mcp-keys — lista las keys del usuario actual (sin exponer la key completa)
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('mcp_api_keys')
    .select('id, label, key_preview, last_used_at, created_at, revoked_at')
    .eq('team_member_id', req.teamMember.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/mcp-keys  { label? } — genera una key nueva, la muestra UNA sola vez
router.post('/', async (req, res) => {
  const rawKey = 'bitcrm_mcp_' + crypto.randomBytes(24).toString('hex');
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyPreview = rawKey.slice(-4);

  const { data, error } = await supabase
    .from('mcp_api_keys')
    .insert({
      team_member_id: req.teamMember.id,
      label: req.body.label || 'Claude Desktop',
      key_hash: keyHash,
      key_preview: keyPreview,
    })
    .select('id, label, key_preview, created_at')
    .single();

  if (error) return res.status(400).json({ error: error.message });

  // La key completa solo se devuelve en esta respuesta — nunca más se puede recuperar
  res.status(201).json({ ...data, key: rawKey });
});

// DELETE /api/mcp-keys/:id — revoca una key
router.delete('/:id', async (req, res) => {
  const { error } = await supabase
    .from('mcp_api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('team_member_id', req.teamMember.id);

  if (error) return res.status(400).json({ error: error.message });
  res.status(204).send();
});

module.exports = router;
