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

  const { data: existingProfile } = await supabase.from('team_members').select('id').eq('email', email).maybeSingle();
  if (existingProfile) return res.status(400).json({ error: 'Ya existe un perfil de equipo con ese correo.' });

  let authUserId;
  const { data: authUser, error: authError } = await supabase.auth.admin.inviteUserByEmail(email, {
    redirectTo: process.env.FRONTEND_ORIGIN ? process.env.FRONTEND_ORIGIN.split(',')[0] : undefined,
  });

  if (authError) {
    // El correo ya tiene una cuenta en Supabase Auth (ej. intentó entrar con Google antes
    // de ser invitado). En vez de fallar, reutilizamos esa cuenta y le mandamos un link
    // para poner su contraseña, así queda con acceso igual.
    const alreadyRegistered = /already.*registered/i.test(authError.message);
    if (!alreadyRegistered) {
      return res.status(400).json({ error: `No se pudo enviar la invitación: ${authError.message}` });
    }

    const { data: userList, error: listError } = await supabase.auth.admin.listUsers();
    if (listError) return res.status(400).json({ error: `No se pudo ubicar la cuenta existente: ${listError.message}` });

    const found = userList.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (!found) return res.status(400).json({ error: 'El correo ya está registrado en Auth, pero no lo pude ubicar. Contacta soporte.' });
    authUserId = found.id;

    await supabase.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: { redirectTo: process.env.FRONTEND_ORIGIN ? process.env.FRONTEND_ORIGIN.split(',')[0] : undefined },
    }).catch(() => {}); // best-effort: si falla el link, igual queda con acceso y puede usar "olvidé mi contraseña"
  } else {
    authUserId = authUser.user.id;
  }

  const { data: member, error } = await supabase
    .from('team_members')
    .insert({ full_name, email, role: role || 'operaciones', active: true, auth_user_id: authUserId })
    .select()
    .single();

  if (error) {
    // Si falla la creación del perfil y el usuario de Auth se creó recién (no existía antes), no lo dejamos huérfano
    if (!authError) await supabase.auth.admin.deleteUser(authUserId);
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
