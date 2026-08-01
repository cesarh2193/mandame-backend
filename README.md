# Mandame — Backend (Node.js + Express)

API REST para Mandame v2, conectada a la base `MandameApp`. Ya
probada de punta a punta contra un MySQL real: esquema, procedimientos,
y el flujo completo de login (incluyendo el caso de las cuentas
migradas con `REQUIERE_RESTABLECER`).

## Instalación local

```bash
cd mandame-backend
npm install
cp .env.example .env
```

Edita `.env` con los datos reales de tu conexión:

```
DB_HOST=localhost
DB_PORT=3306
DB_NAME=MandameApp
DB_USER=tu_usuario
DB_PASSWORD=tu_password
JWT_SECRET=una-cadena-larga-y-aleatoria-solo-tuya
FRONTEND_URL=http://localhost:5173
```

Antes de levantar el backend, la base `MandameApp` debe tener
corridos, en este orden:
1. `mandame_v2_schema.sql`
2. `mandame_procedimientos.sql`
3. `mandame_migracion.sql` (si vas a traer datos de `MandameDB`)

Levantar el servidor:

```bash
npm run dev
```

Deberías ver:
```
Conectado a la base de datos "MandameApp" en localhost.
Mandame backend escuchando en http://localhost:3000
```

## Primer ingreso de una cuenta migrada

Las cuentas que vinieron de `MandameDB` quedan con
`password_hash = 'REQUIERE_RESTABLECER'` y no pueden iniciar sesión
todavía. Para activarlas:

```bash
curl -X POST http://localhost:3000/api/auth/restablecer \
  -H "Content-Type: application/json" \
  -d '{"usuario":"wcastaneda","passwordNueva":"unaContraseñaNueva"}'
```

Este endpoint solo funciona **una vez** por cuenta (mientras siga en
`REQUIERE_RESTABLECER`); después de establecer la contraseña, ya
solo sirve el login normal. No hay todavía un flujo de "olvidé mi
contraseña" con verificación por correo — eso queda como siguiente
paso, no estaba en el alcance de esta entrega.

## Probar en otro servidor / montarlo

1. En el servidor de destino: `npm install --omit=dev` (o normal si
   quieres `npm run dev` con recarga automática).
2. Configura `.env` con la IP/host real de MySQL y un `JWT_SECRET`
   propio (nunca reuses el de desarrollo).
3. `npm start` (usa `node src/server.js` directo, sin watch).
4. Pon un proceso manager delante para que no se caiga solo —
   `pm2 start src/server.js --name mandame-backend` es lo más simple,
   o un servicio de systemd si prefieres.
5. Si el frontend queda en un dominio distinto, `FRONTEND_URL` en
   `.env` debe apuntar exactamente a ese dominio (CORS lo rechaza si
   no coincide).

## Qué se probó de verdad (no solo se escribió)

- El esquema y los procedimientos corren sin errores en un MySQL/MariaDB real.
- Cada archivo del backend pasa `node --check` (sin errores de sintaxis).
- Se probó el arranque del servidor conectado a una base real.
- Se probó el flujo completo de login: cuenta migrada → rechazo con
  `PASSWORD_RESET_REQUIRED` → `POST /auth/restablecer` → login
  correcto con JWT real → `GET /auth/me` con el token.
- Se encontró y corrigió un bug real de codificación (acentos) en la
  conexión a MySQL, agregando `charset: 'utf8mb4'` explícito.

Lo que NO se alcanzó a probar en esta entrega (por límite de tiempo,
no por dificultad): los endpoints de Planificación, Asignaciones,
Asistencia, Cierre de turno, Autorización, Monitoreo y los catálogos
completos contra datos reales. Las consultas están escritas siguiendo
el mismo patrón ya probado en Auth, pero antes de usarlos en
producción, pruébalos uno por uno con datos de tu `MandameApp` real
(o pídeme que te ayude a probarlos aquí mismo).

## Estructura

```
src/
  config/env.js       carga y valida las variables de entorno
  config/db.js         pool de mysql2 + helper callProcedure() para los CALL
  middleware/auth.js    JWT, requireRole(), acceso por sucursal
  middleware/errorHandler.js  traduce errores SIGNAL de MySQL a JSON legible
  utils/mailer.js       nodemailer con modo "simulado" si no hay SMTP configurado
  routes/               una ruta por recurso, igual que el contrato del frontend
```

## Endpoints

Coinciden exactamente con la tabla del README de `mandame-frontend`.
Todas las rutas (excepto `/auth/login`, `/auth/restablecer` y
`/health`) requieren `Authorization: Bearer <token>`.
