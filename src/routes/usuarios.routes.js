import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../config/db.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(authenticate, requireRole('Admin'));

// GET /api/usuarios
router.get('/', asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT u.usuario_id AS id, u.usuario, u.email AS correo, CONCAT(p.nombres,' ',p.apellidos) AS nombre, u.estado
     FROM usuario u JOIN persona p ON p.persona_id = u.persona_id
     ORDER BY p.nombres`
  );

  // roles y sucursales por usuario, en consultas simples (evita duplicar filas con un JOIN 1:N)
  const [rolesRows] = await pool.query(
    `SELECT ur.usuario_id, r.nombre AS rol FROM usuario_rol ur JOIN rol r ON r.rol_id = ur.rol_id`
  );
  const rolesPorUsuario = new Map();
  for (const rr of rolesRows) {
    if (!rolesPorUsuario.has(rr.usuario_id)) rolesPorUsuario.set(rr.usuario_id, []);
    rolesPorUsuario.get(rr.usuario_id).push(rr.rol);
  }

  const [sucursalesRows] = await pool.query(
    `SELECT us.usuario_id, s.sucursal_id AS id, s.nombre FROM usuario_sucursal us JOIN sucursal s ON s.sucursal_id = us.sucursal_id`
  );
  const sucursalesPorUsuario = new Map();
  for (const sr of sucursalesRows) {
    if (!sucursalesPorUsuario.has(sr.usuario_id)) sucursalesPorUsuario.set(sr.usuario_id, []);
    sucursalesPorUsuario.get(sr.usuario_id).push({ id: sr.id, nombre: sr.nombre });
  }

  res.json(rows.map((u) => ({
    ...u,
    roles: rolesPorUsuario.get(u.id) || [],
    sucursales: sucursalesPorUsuario.get(u.id) || []
  })));
}));

// POST /api/usuarios  { personaId, usuario, correo, password, roles: [] }
router.post('/', asyncHandler(async (req, res) => {
  const { personaId, usuario, correo, password, roles = [], sucursalIds = [] } = req.body;
  if (!personaId || !usuario || !correo || !password) {
    return res.status(400).json({ error: 'personaId, usuario, correo y password son requeridos.' });
  }

  const hash = await bcrypt.hash(password, 10);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.query(
      `INSERT INTO usuario (persona_id, usuario, password_hash, email) VALUES (?, ?, ?, ?)`,
      [personaId, usuario, hash, correo]
    );
    const usuarioId = result.insertId;

    for (const nombreRol of roles) {
      await conn.query(
        `INSERT INTO usuario_rol (usuario_id, rol_id)
         SELECT ?, rol_id FROM rol WHERE nombre = ?`,
        [usuarioId, nombreRol]
      );
    }

    for (const sucursalId of sucursalIds) {
      await conn.query(`INSERT INTO usuario_sucursal (usuario_id, sucursal_id) VALUES (?, ?)`, [usuarioId, sucursalId]);
    }

    await conn.commit();
    res.status(201).json({ id: usuarioId });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

// PUT /api/usuarios/:id  { correo, roles: [], nuevaPassword?, estado? }
router.put('/:id', asyncHandler(async (req, res) => {
  const { correo, roles, nuevaPassword, estado, sucursalIds } = req.body;
  const usuarioId = req.params.id;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (correo || estado) {
      await conn.query(
        `UPDATE usuario SET email = COALESCE(?, email), estado = COALESCE(?, estado) WHERE usuario_id = ?`,
        [correo, estado, usuarioId]
      );
    }

    if (nuevaPassword) {
      const hash = await bcrypt.hash(nuevaPassword, 10);
      await conn.query(`UPDATE usuario SET password_hash = ? WHERE usuario_id = ?`, [hash, usuarioId]);
    }

    if (Array.isArray(roles)) {
      await conn.query(`DELETE FROM usuario_rol WHERE usuario_id = ?`, [usuarioId]);
      for (const nombreRol of roles) {
        await conn.query(
          `INSERT INTO usuario_rol (usuario_id, rol_id) SELECT ?, rol_id FROM rol WHERE nombre = ?`,
          [usuarioId, nombreRol]
        );
      }
    }

    if (Array.isArray(sucursalIds)) {
      await conn.query(`DELETE FROM usuario_sucursal WHERE usuario_id = ?`, [usuarioId]);
      for (const sucursalId of sucursalIds) {
        await conn.query(`INSERT INTO usuario_sucursal (usuario_id, sucursal_id) VALUES (?, ?)`, [usuarioId, sucursalId]);
      }
    }

    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

export default router;
