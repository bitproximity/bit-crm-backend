const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const { KNOWN_RESOURCES } = require('../middleware/rolePermissions');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('admin'));

const KNOWN_ROLES = ['operaciones', 'outbound', 'wifi_partner', 'ventas'];

// GET /api/role-permissions — matriz completa rol x recurso, sembrando en false lo que
// todavía no tenga fila (para que el panel siempre muestre algo, incluso recién agregado
// un recurso nuevo a KNOWN_RESOURCES sin haber corrido una migración de siembra).
router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('role_permissions').select('*');
  if (error) return res.status(500).json({ error: error.message });

  const existing = new Set((data || []).map((r) => `${r.role}|${r.resource}`));
  const rows = [...(data || [])];
  KNOWN_ROLES.forEach((role) => {
    KNOWN_RESOURCES.forEach((resource) => {
      if (!existing.has(`${role}|${resource}`)) rows.push({ id: null, role, resource, can_view: false, can_manage: false });
    });
  });
  res.json(rows);
});

// PATCH /api/role-permissions  { role, resource, can_view, can_manage }
router.patch('/', async (req, res) => {
  const { role, resource, can_view, can_manage } = req.body;
  if (!role || !resource) return res.status(400).json({ error: 'Faltan role o resource' });
  if (!KNOWN_RESOURCES.includes(resource)) return res.status(400).json({ error: 'Recurso desconocido' });

  const { data, error } = await supabase
    .from('role_permissions')
    .upsert({ role, resource, can_view: !!can_view, can_manage: !!can_manage, updated_at: new Date().toISOString() }, { onConflict: 'role,resource' })
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

module.exports = router;
