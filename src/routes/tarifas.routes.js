import { Router } from 'express';
import { pool } from '../config/db.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(authenticate);

// GET /api/tarifas?estado=A
router.get('/', asyncHandler(async (req, res) => {
  const { estado } = req.query;
  const params = [];
  let where = '';
  if (estado) { where = 'WHERE estado = ?'; params.push(estado); }
  const [rows] = await pool.query(
    `SELECT tarifa_id AS id, descripcion, tipo, valor, estado FROM tarifa ${where} ORDER BY descripcion`,
    params
  );
  res.json(rows);
}));

// POST /api/tarifas
router.post('/', requireRole('Admin'), asyncHandler(async (req, res) => {
  const { descripcion, tipo, valor } = req.body;
  const [result] = await pool.query(
    `INSERT INTO tarifa (descripcion, tipo, valor, vigente_desde) VALUES (?, ?, ?, CURDATE())`,
    [descripcion, tipo, valor]
  );
  res.status(201).json({ id: result.insertId });
}));

// PUT /api/tarifas/:id — a propósito NO acepta "tipo": una vez
// creada la tarifa, cómo se calcula no se puede cambiar. Solo
// descripción y valor.
router.put('/:id', requireRole('Admin'), asyncHandler(async (req, res) => {
  const { descripcion, valor } = req.body;
  await pool.query(
    `UPDATE tarifa SET descripcion = COALESCE(?, descripcion), valor = COALESCE(?, valor) WHERE tarifa_id = ?`,
    [descripcion, valor, req.params.id]
  );
  res.json({ ok: true });
}));

// A propósito NO hay ruta de dar-de-baja para tarifas: quedan
// activas siempre, son referencia histórica de pago.

export default router;
