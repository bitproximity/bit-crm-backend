# Bit CRM — Backend

API REST del CRM interno de Bit Proximity (mix Pipedrive + Asana) para el equipo
comercial y operativo. Contactos/leads B2B, pipeline de ventas, proyectos, tareas
con subtareas, onboarding por plantillas, etiquetas y auditoría completa.

## Stack
- Node.js + Express
- Supabase (Postgres) — proyecto **separado** del de los tenants de Bit Proximity
- Deploy: Railway (igual que el backend principal)

## Setup

1. Correr `schema.sql` en el SQL Editor del proyecto de Supabase (`bit-crm`). Ya lo hiciste.
2. Copiar `.env.example` a `.env` y completar:
   - `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` — Project Settings → API en Supabase.
   - `FRONTEND_ORIGIN` — dominio del frontend (ej. `https://crm.bitproximity.com`).
3. Local: `npm install && npm run dev`
4. Deploy: subir este repo a GitHub → conectar en Railway → variables de entorno en Railway → deploy automático en cada push (mismo flujo que ya usas).

## Primer usuario admin

Antes de usar la app hay que crear el primer usuario a mano:

1. En Supabase → Authentication → Users → **Add user** (tu email + password).
2. Copiar el `id` (UUID) de ese usuario.
3. En SQL Editor:
   ```sql
   insert into team_members (auth_user_id, full_name, email, role)
   values ('<uuid-del-usuario>', 'Mario Ramos', 'tu-email@bitproximity.com', 'admin');
   ```
4. Insertar las stages del pipeline por defecto (el `pipelines` inicial ya se creó en el seed del schema):
   ```sql
   -- reemplazar <pipeline_id> por el id real (select id from pipelines limit 1;)
   insert into pipeline_stages (pipeline_id, name, position, is_won, is_lost) values
     ('<pipeline_id>', 'Prospecto', 1, false, false),
     ('<pipeline_id>', 'Contactado', 2, false, false),
     ('<pipeline_id>', 'Demo agendada', 3, false, false),
     ('<pipeline_id>', 'Propuesta enviada', 4, false, false),
     ('<pipeline_id>', 'Negociación', 5, false, false),
     ('<pipeline_id>', 'Ganado', 6, true, false),
     ('<pipeline_id>', 'Perdido', 7, false, true);
   ```

## Endpoints principales

| Recurso | Rutas |
|---|---|
| Equipo | `GET/POST /api/team`, `GET /api/team/me` |
| Contactos | `GET/POST/PATCH/DELETE /api/contacts` |
| Empresas | `GET/POST/PATCH/DELETE /api/companies` |
| Pipelines | `GET/POST /api/pipelines`, `POST /api/pipelines/:id/stages` |
| Deals | `GET/POST/PATCH /api/deals`, `PATCH /api/deals/:id/stage`, `POST /api/deals/:id/win`, `POST /api/deals/:id/lose` |
| Proyectos | `GET/POST/PATCH/DELETE /api/projects` |
| Tareas | `GET/POST/PATCH/DELETE /api/tasks`, `POST /api/tasks/:id/comments` |
| Tags | `GET/POST /api/tags`, `POST /api/tags/:id/attach`, `DELETE /api/tags/:id/detach` |
| Actividades | `GET /api/activities/for/:type/:id`, `POST /api/activities` |
| Plantillas onboarding | `GET/POST/PATCH/DELETE /api/templates` |
| Dashboard | `GET /api/dashboard` |

Todas las rutas (salvo `/health`) requieren header `Authorization: Bearer <supabase_jwt>`.

## Trazabilidad

Cada creación/edición/borrado/cambio de etapa/asignación queda registrada en
`audit_log` con quién, qué campo cambió y cuándo — vía el helper `utils/audit.js`.

## Multimoneda

`deals.currency` acepta: `USD, COP, MXN, PYG, DOP, EUR`. La tabla
`exchange_rates` guarda la conversión manual de cada moneda a USD (se puede
actualizar vía `PATCH /api/exchange-rates/:currency`, solo admin) — el
dashboard usa esas tasas para sumar el pipeline abierto en un solo número
aunque haya deals en distintas monedas. Correr `migration_002...sql` antes
de usar esto.

## Campos personalizados

`GET/POST /api/custom-fields?entity_type=deal` define campos nuevos por tipo
de entidad (contacto, empresa, deal, tarea, proyecto). Tipos soportados:
`text, number, date, boolean, select`. Los valores por entidad van en
`GET/PUT /api/custom-fields/values/:entity_id`.

## Integración con Gmail

Requiere crear credenciales OAuth en Google Cloud Console:

1. https://console.cloud.google.com → crea o selecciona un proyecto.
2. **APIs & Services → Library** → habilita **Gmail API**.
3. **APIs & Services → OAuth consent screen** → tipo "Internal" si usas
   Google Workspace con dominio propio (bitproximity.com), o "External" +
   agregar los emails de tu equipo como "Test users" si no.
4. **Credentials → Create Credentials → OAuth client ID** → tipo "Web application".
5. **Authorized redirect URIs** → agrega exactamente:
   `https://tu-backend.up.railway.app/api/gmail/callback`
6. Copia el **Client ID** y **Client Secret** → variables en Railway:
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.

Cada usuario del equipo conecta su propia cuenta desde el frontend
(Configuración → Conectar Gmail). Los correos sincronizados con un contacto
quedan guardados en `gmail_messages` — es lectura únicamente (scope
`gmail.readonly`), no se puede enviar correos desde el CRM en esta versión.

## Pendiente (siguiente fase)
- Vista de detalle de deal/contacto con hilo de correos de Gmail embebido.
- UI de administración de campos personalizados (hoy solo vía API).
- Actualización automática de tasas de cambio (hoy es manual).
