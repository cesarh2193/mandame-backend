import { Router } from 'express';
import { pool, callProcedure } from '../config/db.js';
import { authenticate, requireRole, requireAccesoSucursal } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(authenticate);

// GET /api/planificacion?fecha=
router.get('/', asyncHandler(async (req, res) => {
  const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);
  const sucursalIds = req.user.sucursalIds;
  const esAdmin = req.user.roles.includes('Admin');

  const [rows] = await pool.query(
    `SELECT pl.sucursal_id AS sucursalId, s.nombre AS sucursalNombre,
            pl.motoristas_plan AS total, u.usuario AS registradoPor
     FROM planificacion pl
     JOIN sucursal s ON s.sucursal_id = pl.sucursal_id
     LEFT JOIN usuario u ON u.usuario_id = pl.usuario_crea_id
     WHERE pl.fecha = ? ${esAdmin ? '' : 'AND pl.sucursal_id IN (?)'}`,
    esAdmin ? [fecha] : [fecha, sucursalIds.length ? sucursalIds : [0]]
  );
  res.json(rows);
}));

// POST /api/planificacion  { sucursalId, fecha, total }
router.post('/',
  requireRole('Supervisor', 'Gerente'),
  requireAccesoSucursal((req) => req.body.sucursalId),
  asyncHandler(async (req, res) => {
    const { sucursalId, fecha, total } = req.body;
    await callProcedure('sp_registrar_planificacion', [sucursalId, fecha, total, req.user.usuarioId]);
    res.status(201).json({ ok: true });
  })
);

export default router;
