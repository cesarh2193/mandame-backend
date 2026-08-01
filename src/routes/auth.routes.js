import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../config/db.js';
import { env } from '../config/env.js';
import { authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();

async function cargarRolesYSucursales(usuarioId) {
  const [roles] = await pool.query(
    `SELECT r.nombre FROM usuario_rol ur JOIN rol r ON r.rol_id = ur.rol_id WHERE ur.usuario_id = ?`,
    [usuarioId]
  );
  const esAdmin = roles.some((r) => r.nombre === 'Admin');

  let sucursales = [];
  if (esAdmin) {
    const [todas] = await pool.query(`SELECT sucursal_id AS id, nombre FROM sucursal WHERE estado = 'A'`);
    sucursales = todas;
  } else {
    const [propias] = await pool.query(
      `SELECT s.sucursal_id AS id, s.nombre
       FROM usuario_sucursal us JOIN sucursal s ON s.sucursal_id = us.sucursal_id
       WHERE us.usuario_id = ?`,
      [usuarioId]
    );
    sucursales = propias;
  }

  return { roles: roles.map((r) => r.nombre), sucursales };
}

function firmarToken({ usuarioId, usuario, nombre, roles, sucursales }) {
  return jwt.sign(
    { usuarioId, usuario, nombre, roles, sucursalIds: sucursales.map((s) => s.id) },
    env.jwt.secret,
    { expiresIn: env.jwt.expiresIn }
  );
}

// POST /api/auth/login
router.post('/login', asyncHandler(async (req, res) => {
  const { usuario, password } = req.body;
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña son requeridos.' });
  }

  const [rows] = await pool.query(
    `SELECT u.usuario_id, u.usuario, u.password_hash, u.estado,
            CONCAT(p.nombres, ' ', p.apellidos) AS nombre
     FROM usuario u JOIN persona p ON p.persona_id = u.persona_id
     WHERE u.usuario = ?`,
    [usuario]
  );
  const cuenta = rows[0];

  // Mismo mensaje genérico si no existe el usuario o si la
  // contraseña no coincide — no hay que darle pistas a quien
  // intenta adivinar usuarios válidos.
  if (!cuenta) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }

  if (cuenta.password_hash === 'REQUIERE_RESTABLECER') {
    return res.status(403).json({
      error: 'Esta cuenta viene de la migración y todavía no tiene contraseña. Debes restablecerla primero.',
      code: 'PASSWORD_RESET_REQUIRED'
    });
  }

  if (cuenta.estado === 'BLOQUEADO' || cuenta.estado === 'I') {
    return res.status(403).json({ error: 'Esta cuenta está inactiva. Contacta a un administrador.' });
  }

  const coincide = await bcrypt.compare(password, cuenta.password_hash);
  if (!coincide) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }

  const { roles, sucursales } = await cargarRolesYSucursales(cuenta.usuario_id);
  const token = firmarToken({ usuarioId: cuenta.usuario_id, usuario: cuenta.usuario, nombre: cuenta.nombre, roles, sucursales });

  await pool.query(`UPDATE usuario SET ultimo_acceso = NOW() WHERE usuario_id = ?`, [cuenta.usuario_id]);

  res.json({
    token,
    usuario: { nombre: cuenta.nombre, roles, rolActivo: roles[0] || null, sucursales }
  });
}));

// POST /api/auth/restablecer
// Bootstrap de una sola vez para las cuentas migradas con
// password_hash = 'REQUIERE_RESTABLECER'. Una vez que la cuenta
// ya tiene un hash real, este endpoint deja de aceptar cambios
// (para eso se necesita un flujo de "olvidé mi contraseña" con
// verificación, que no es parte de este alcance todavía).
router.post('/restablecer', asyncHandler(async (req, res) => {
  const { usuario, passwordNueva } = req.body;
  if (!usuario || !passwordNueva || passwordNueva.length < 8) {
    return res.status(400).json({ error: 'Usuario y una contraseña nueva de al menos 8 caracteres son requeridos.' });
  }

  const [rows] = await pool.query(`SELECT usuario_id, password_hash FROM usuario WHERE usuario = ?`, [usuario]);
  const cuenta = rows[0];
  if (!cuenta) {
    return res.status(404).json({ error: 'Usuario no encontrado.' });
  }
  if (cuenta.password_hash !== 'REQUIERE_RESTABLECER') {
    return res.status(409).json({
      error: 'Esta cuenta ya tiene contraseña. Usa el flujo de "olvidé mi contraseña" en vez de este endpoint.'
    });
  }

  const hash = await bcrypt.hash(passwordNueva, 10);
  await pool.query(`UPDATE usuario SET password_hash = ?, estado = 'A' WHERE usuario_id = ?`, [hash, cuenta.usuario_id]);

  res.json({ ok: true, mensaje: 'Contraseña establecida. Ya puedes iniciar sesión.' });
}));

// GET /api/auth/me
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const { roles, sucursales } = await cargarRolesYSucursales(req.user.usuarioId);
  res.json({ nombre: req.user.nombre, roles, rolActivo: roles[0] || null, sucursales });
}));

export default router;
