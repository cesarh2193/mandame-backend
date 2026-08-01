import { Router } from 'express';
import { pool } from '../config/db.js';
import { authenticate, esAdministrador, tieneAccesoSucursal } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(authenticate);

// GET /api/dashboard/hoy?sucursalId=
// Sin sucursalId: agrega TODAS las sucursales a las que el usuario
// tiene acceso (para Admin, todas las activas) — evita que la
// pantalla "Hoy" solo muestre datos de la primera CAD de la lista
// mientras el resto queda con planificación/cierres sin contar.
router.get('/hoy', asyncHandler(async (req, res) => {
  const { sucursalId } = req.query;
  let filtroSucursal = '1=1';
  const params = [];

  if (sucursalId) {
    if (!tieneAccesoSucursal(req, sucursalId)) {
      return res.status(403).json({ error: 'No tienes acceso a esta sucursal.' });
    }
    filtroSucursal = 'a.sucursal_id = ?';
    params.push(Number(sucursalId));
  } else if (!esAdministrador(req)) {
    filtroSucursal = 'a.sucursal_id IN (?)';
    params.push(req.user.sucursalIds?.length ? req.user.sucursalIds : [0]);
  }

  const [[{ planificados }]] = await pool.query(
    `SELECT COALESCE(SUM(motoristas_plan),0) AS planificados
     FROM planificacion pl
     JOIN sucursal s ON s.sucursal_id = pl.sucursal_id
     WHERE pl.fecha = CURDATE() AND ${filtroSucursal.replace('a.sucursal_id', 'pl.sucursal_id')}`,
    params
  );

  const [enTurnoRows] = await pool.query(
    `SELECT a.asignacion_id, CONCAT(p.nombres,' ',p.apellidos) AS nombre, s.nombre AS sucursal
     FROM asignacion a
     JOIN motorista m ON m.persona_id = a.motorista_id
     JOIN persona p ON p.persona_id = m.persona_id
     JOIN sucursal s ON s.sucursal_id = a.sucursal_id
     JOIN asistencia_marca ingreso
       ON ingreso.asignacion_id = a.asignacion_id
      AND ingreso.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'INGRESO')
      AND DATE(ingreso.fecha_hora) = CURDATE()
     LEFT JOIN asistencia_marca salida
       ON salida.asignacion_id = a.asignacion_id
      AND salida.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'SALIDA')
      AND DATE(salida.fecha_hora) = CURDATE()
     WHERE salida.marca_id IS NULL AND ${filtroSucursal}`,
    params
  );

  const [[{ cerrados }]] = await pool.query(
    `SELECT COUNT(*) AS cerrados
     FROM reparto r JOIN asignacion a ON a.asignacion_id = r.asignacion_id
     WHERE r.fecha = CURDATE() AND ${filtroSucursal}`,
    params
  );

  res.json({
    planificados,
    enTurno: enTurnoRows.length,
    pendientesCierre: enTurnoRows.length,
    cerrados,
    listaPendientes: enTurnoRows
  });
}));

// GET /api/dashboard/cuadre-cads (solo Administrador)
router.get('/cuadre-cads', asyncHandler(async (req, res) => {
  if (!esAdministrador(req)) return res.json([]);

  const [rows] = await pool.query(`
    SELECT s.sucursal_id AS id, s.nombre AS sucursal,
           COALESCE(pl.motoristas_plan, 0) AS plan,
           COUNT(DISTINCT ing.asignacion_id) AS asistieron
    FROM sucursal s
    LEFT JOIN planificacion pl ON pl.sucursal_id = s.sucursal_id AND pl.fecha = CURDATE()
    LEFT JOIN asignacion a ON a.sucursal_id = s.sucursal_id AND CURDATE() BETWEEN a.fecha_inicio AND a.fecha_fin
    LEFT JOIN asistencia_marca ing
      ON ing.asignacion_id = a.asignacion_id
     AND ing.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'INGRESO')
     AND DATE(ing.fecha_hora) = CURDATE()
    WHERE s.estado = 'A'
    GROUP BY s.sucursal_id, s.nombre, pl.motoristas_plan
    ORDER BY s.nombre
  `);

  res.json(rows);
}));

export default router;
