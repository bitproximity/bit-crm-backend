const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('team_members')
    .select('id, full_name, email, role, active, created_at')
    .order('full_name');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/team/invite  { full_name, email, role }
// Crea el login real en Supabase Auth (manda correo de invitación) + el perfil en team_members.
// Solo admin puede invitar.
router.post('/invite', requireRole('admin'), async (req, res) => {
  const { full_name, email, role } = req.body;
  if (!full_name || !email) return res.status(400).json({ error: 'Falta nombre o correo' });

  const { data: authUser, error: authError } = await supabase.auth.admin.inviteUserByEmail(email, {
    redirectTo: process.env.FRONTEND_ORIGIN ? process.env.FRONTEND_ORIGIN.split(',')[0] : undefined,
  });

  if (authError) return res.status(400).json({ error: `No se pudo enviar la invitación: ${authError.message}` });

  const { data: member, error } = await supabase
    .from('team_members')
    .insert({ full_name, email, role: role || 'vendedor', active: true, auth_user_id: authUser.user.id })
    .select()
    .single();

  if (error) {
    // Si falla la creación del perfil, no dejamos un usuario de Auth huérfano
    await supabase.auth.admin.deleteUser(authUser.user.id);
    return res.status(400).json({ error: error.message });
  }

  res.status(201).json(member);
});

// Solo admin invita/crea miembros nuevos (el alta de auth se hace en Supabase Auth aparte)
router.post('/', requireRole('admin'), async (req, res) => {
  const { data, error } = await supabase.from('team_members').insert(req.body).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

router.patch('/:id', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('team_members')
    .update(req.body)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE /api/team/:id — revoca el acceso: desactiva el perfil y bloquea el login en Supabase Auth
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { data: member } = await supabase.from('team_members').select('auth_user_id').eq('id', id).single();

  const { error } = await supabase.from('team_members').update({ active: false }).eq('id', id);
  if (error) return res.status(400).json({ error: error.message });

  if (member?.auth_user_id) {
    await supabase.auth.admin.updateUserById(member.auth_user_id, { ban_duration: '876000h' }); // ~100 años, revocación efectiva
  }

  res.status(204).send();
});

// GET /api/team/me — perfil del usuario autenticado
router.get('/me', async (req, res) => {
  res.json(req.teamMember);
});

module.exports = router;
