import { Router } from 'express';
import { pool } from '../config/db.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const empresasRouter = Router();
export const sucursalesRouter = Router();
empresasRouter.use(authenticate);
sucursalesRouter.use(authenticate);

// ---------- Empresas ----------
// ?estado=A para traer solo activas (formularios que asignan empresa/CAD).
// Sin ese filtro trae todas (la pantalla de administración necesita ver
// también las de baja para poder reactivarlas), activas primero.
empresasRouter.get('/', asyncHandler(async (req, res) => {
  const { estado } = req.query;
  const where = estado ? 'WHERE e.estado = ?' : '';
  const params = estado ? [estado] : [];

  const [rows] = await pool.query(
    `SELECT e.empresa_id AS id, e.codigo, e.nombre, e.estado,
            (SELECT COUNT(*) FROM sucursal s WHERE s.empresa_id = e.empresa_id) AS sucursales
     FROM empresa e ${where} ORDER BY (e.estado = 'A') DESC, e.nombre`,
    params
  );
  res.json(rows);
}));

empresasRouter.post('/', requireRole('Admin'), asyncHandler(async (req, res) => {
  const { codigo, nombre } = req.body;
  const [result] = await pool.query(`INSERT INTO empresa (codigo, nombre) VALUES (?, ?)`, [codigo, nombre]);
  res.status(201).json({ id: result.insertId });
}));

empresasRouter.put('/:id', requireRole('Admin'), asyncHandler(async (req, res) => {
  const { nombre, estado } = req.body;
  await pool.query(`UPDATE empresa SET nombre = COALESCE(?, nombre), estado = COALESCE(?, estado) WHERE empresa_id = ?`,
    [nombre, estado, req.params.id]);
  res.json({ ok: true });
}));

empresasRouter.post('/:id/dar-de-baja', requireRole('Admin'), asyncHandler(async (req, res) => {
  await pool.query(`UPDATE empresa SET estado = 'I' WHERE empresa_id = ?`, [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Sucursales ----------
// ?estado=A para traer solo CAD activas de empresas activas (formularios
// que asignan CAD). Sin ese filtro trae todas, activas primero.
sucursalesRouter.get('/', asyncHandler(async (req, res) => {
  const { empresaId, estado } = req.query;
  const condiciones = [];
  const params = [];
  if (empresaId) { condiciones.push('s.empresa_id = ?'); params.push(empresaId); }
  if (estado) { condiciones.push('s.estado = ?'); condiciones.push('e.estado = ?'); params.push(estado, estado); }
  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

  const [rows] = await pool.query(
    `SELECT s.sucursal_id AS id, s.codigo_cad AS codigoCad, s.nombre, s.estado,
            e.nombre AS empresaNombre, CONCAT(p.nombres,' ',p.apellidos) AS supervisor
     FROM sucursal s
     JOIN empresa e ON e.empresa_id = s.empresa_id
     LEFT JOIN persona p ON p.persona_id = s.supervisor_id
     ${where}
     ORDER BY (s.estado = 'A' AND e.estado = 'A') DESC, s.nombre`,
    params
  );
  res.json(rows);
}));

sucursalesRouter.post('/', requireRole('Admin'), asyncHandler(async (req, res) => {
  const { empresaId, codigoCad, nombre, supervisorId } = req.body;
  const [result] = await pool.query(
    `INSERT INTO sucursal (empresa_id, codigo_cad, nombre, supervisor_id) VALUES (?, ?, ?, ?)`,
    [empresaId, codigoCad, nombre, supervisorId || null]
  );
  res.status(201).json({ id: result.insertId });
}));

sucursalesRouter.put('/:id', requireRole('Admin'), asyncHandler(async (req, res) => {
  const { nombre, supervisorId, estado } = req.body;
  await pool.query(
    `UPDATE sucursal SET nombre = COALESCE(?, nombre), supervisor_id = COALESCE(?, supervisor_id), estado = COALESCE(?, estado)
     WHERE sucursal_id = ?`,
    [nombre, supervisorId, estado, req.params.id]
  );
  res.json({ ok: true });
}));

sucursalesRouter.post('/:id/dar-de-baja', requireRole('Admin'), asyncHandler(async (req, res) => {
  await pool.query(`UPDATE sucursal SET estado = 'I' WHERE sucursal_id = ?`, [req.params.id]);
  res.json({ ok: true });
}));
