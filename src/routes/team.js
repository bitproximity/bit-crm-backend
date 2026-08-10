const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Dominio fijo para los links de correo (invitación, recuperación). No depende del
// orden de FRONTEND_ORIGIN (que puede tener varios dominios viejos mezclados) —
// así un link nunca vuelve a apuntar a un deploy abandonado.
const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || 'https://crm.bitproximity.com';

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
    redirectTo: PUBLIC_APP_URL,
  });

  if (authError) {
    // El correo ya tiene una cuenta en Supabase Auth (ej. intentó entrar con Google antes
    // de ser invitado). En vez de fallar, reutilizamos esa cuenta y le mandamos un correo
    // real de recuperación de contraseña (generateLink() NO manda correo por sí solo,
    // solo genera el link — por eso usamos resetPasswordForEmail, que sí lo envía).
    const alreadyRegistered = /already.*registered/i.test(authError.message);
    if (!alreadyRegistered) {
      return res.status(400).json({ error: `No se pudo enviar la invitación: ${authError.message}` });
    }

    const { data: userList, error: listError } = await supabase.auth.admin.listUsers();
    if (listError) return res.status(400).json({ error: `No se pudo ubicar la cuenta existente: ${listError.message}` });

    const found = userList.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (!found) return res.status(400).json({ error: 'El correo ya está registrado en Auth, pero no lo pude ubicar. Contacta soporte.' });
    authUserId = found.id;

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: PUBLIC_APP_URL });
    if (resetError) console.error('No se pudo enviar el correo de recuperación:', resetError.message);
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

// POST /api/team/:id/resend-access — reenvía el acceso a alguien que YA tiene perfil
// (link expirado, nunca le llegó, etc.). Borra su cuenta de Auth vieja y crea una
// completamente nueva: Supabase a veces reutiliza el mismo token (aunque haya
// "expirado" del lado del link) si la cuenta sigue existiendo, así que la única forma
// confiable de garantizar un link realmente nuevo es partir de una cuenta nueva.
router.post('/:id/resend-access', requireRole('admin'), async (req, res) => {
  const { data: member } = await supabase.from('team_members').select('email, auth_user_id').eq('id', req.params.id).single();
  if (!member) return res.status(404).json({ error: 'Miembro no encontrado' });

  // No confiamos solo en el auth_user_id guardado (puede estar desactualizado) —
  // buscamos la cuenta real de Auth por correo antes de borrar.
  const { data: userList, error: listError } = await supabase.auth.admin.listUsers();
  if (listError) return res.status(400).json({ error: `No se pudo revisar las cuentas existentes: ${listError.message}` });

  const existing = userList.users.find((u) => u.email?.toLowerCase() === member.email.toLowerCase());

  if (existing) {
    const { error: deleteError } = await supabase.auth.admin.deleteUser(existing.id);
    if (deleteError) {
      return res.status(400).json({ error: `No se pudo borrar la cuenta anterior para regenerar el acceso: ${deleteError.message}` });
    }
  }

  const { data: authUser, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(member.email, {
    redirectTo: PUBLIC_APP_URL,
  });

  if (inviteError) return res.status(400).json({ error: `No se pudo crear la nueva invitación: ${inviteError.message}` });

  await supabase.from('team_members').update({ auth_user_id: authUser.user.id }).eq('id', req.params.id);

  res.json({ sent: true, method: 'invite' });
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
