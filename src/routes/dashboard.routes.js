import { Router } from 'express';
import { pool } from '../config/db.js';
import { authenticate, esAdministrador, tieneAccesoSucursal } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { TIPOS_DOCUMENTO_PERSONAL } from '../config/documentosPersonal.js';

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
    WHERE s.estado = 'A' AND s.visible_operativa = 1
    GROUP BY s.sucursal_id, s.nombre, pl.motoristas_plan
    ORDER BY s.nombre
  `);

  res.json(rows);
}));

// GET /api/dashboard/repartos-hoy?sucursalId=
// Cantidad de repartos que cada motorista tuvo al cerrar turno hoy —
// para la gráfica que ve un no-Administrador en "Hoy" (reusa el mismo
// filtro de sucursal que /hoy). Excluye los cierres anulados.
router.get('/repartos-hoy', asyncHandler(async (req, res) => {
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

  const [rows] = await pool.query(
    `SELECT CONCAT(p.nombres,' ',p.apellidos) AS nombre, s.nombre AS sucursal,
            r.cantidad_entregas AS repartos
     FROM reparto r
     JOIN asignacion a ON a.asignacion_id = r.asignacion_id
     JOIN motorista m ON m.persona_id = a.motorista_id
     JOIN persona p ON p.persona_id = m.persona_id
     JOIN sucursal s ON s.sucursal_id = a.sucursal_id
     WHERE r.fecha = CURDATE() AND r.estado <> 'ANULADO' AND ${filtroSucursal}
     ORDER BY r.cantidad_entregas DESC`,
    params
  );

  res.json(rows);
}));

// GET /api/dashboard/documentos-cad?sucursalId=
// % de completitud del expediente de documentos (los 12 de
// TIPOS_DOCUMENTO_PERSONAL) de los motoristas activos, agregado por
// CAD — para ver de un vistazo qué CAD se está quedando atrás en subir
// los documentos de su personal. Mismo alcance de acceso que /hoy.
router.get('/documentos-cad', asyncHandler(async (req, res) => {
  const { sucursalId } = req.query;
  let filtroSucursal = '1=1';
  const params = [];

  if (sucursalId) {
    if (!tieneAccesoSucursal(req, sucursalId)) {
      return res.status(403).json({ error: 'No tienes acceso a esta sucursal.' });
    }
    filtroSucursal = 's.sucursal_id = ?';
    params.push(Number(sucursalId));
  } else if (!esAdministrador(req)) {
    filtroSucursal = 's.sucursal_id IN (?)';
    params.push(req.user.sucursalIds?.length ? req.user.sucursalIds : [0]);
  }

  const tipos = TIPOS_DOCUMENTO_PERSONAL.map((d) => d.tipo);
  const [rows] = await pool.query(
    `SELECT s.sucursal_id AS id, s.nombre AS sucursal,
            COUNT(DISTINCT m.persona_id) AS totalMotoristas,
            COUNT(pd.documento_id) AS totalCargados
     FROM sucursal s
     JOIN persona p ON p.sucursal_base_id = s.sucursal_id AND p.estado = 'A'
     JOIN motorista m ON m.persona_id = p.persona_id AND m.estado = 'A'
     LEFT JOIN persona_documento pd ON pd.persona_id = m.persona_id AND pd.tipo IN (?)
     WHERE s.estado = 'A' AND s.visible_operativa = 1 AND ${filtroSucursal}
     GROUP BY s.sucursal_id, s.nombre
     HAVING totalMotoristas > 0
     ORDER BY s.nombre`,
    [tipos, ...params]
  );

  const totalPosiblesPorMotorista = tipos.length;
  res.json(rows.map((r) => ({
    id: r.id,
    sucursal: r.sucursal,
    totalMotoristas: r.totalMotoristas,
    totalCargados: r.totalCargados,
    totalPosibles: r.totalMotoristas * totalPosiblesPorMotorista,
    porcentaje: Math.round((r.totalCargados / (r.totalMotoristas * totalPosiblesPorMotorista)) * 100)
  })));
}));

export default router;
