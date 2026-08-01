import { Router } from 'express';
import { pool, callProcedure } from '../config/db.js';
import { authenticate, requireRole, requireAccesoSucursal } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(authenticate);

async function existePlanificacion(sucursalId, fecha) {
  const [[{ existe }]] = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM planificacion WHERE sucursal_id = ? AND fecha = ?) AS existe`,
    [sucursalId, fecha]
  );
  return !!existe;
}

// GET /api/asignaciones/disponibles?sucursalId=&fecha=
// Trae motoristas de la sucursal (por sucursal_base_id) y también
// candidatos de otras sucursales que estén libres ese día — eso es
// lo que alimenta la sección "traer motorista de otro CAD".
//
// Antes de nada valida que ya exista planificación para ese CAD y
// esa fecha: sin eso no tiene sentido mostrar motoristas para asignar
// (y así el control de planificación no queda como paso opcional).
router.get('/disponibles', requireAccesoSucursal((req) => req.query.sucursalId), asyncHandler(async (req, res) => {
  const { sucursalId, fecha } = req.query;

  if (!(await existePlanificacion(sucursalId, fecha))) {
    return res.json({ sinPlanificacion: true, motoristas: [] });
  }

  const [rows] = await pool.query(
    `SELECT m.persona_id AS motoristaId, CONCAT(p.nombres,' ',p.apellidos) AS nombre,
            m.tipo_motorista AS tipoMotorista,
            NOT EXISTS (
              SELECT 1 FROM asignacion a
              WHERE a.motorista_id = m.persona_id AND a.estado = 'A'
                AND ? BETWEEN a.fecha_inicio AND a.fecha_fin
            ) AND NOT EXISTS (
              SELECT 1 FROM asistencia_marca am
              JOIN asignacion a2 ON a2.asignacion_id = am.asignacion_id
              WHERE a2.motorista_id = m.persona_id AND DATE(am.fecha_hora) = ?
            ) AS disponible
     FROM motorista m
     JOIN persona p ON p.persona_id = m.persona_id
     WHERE p.sucursal_base_id = ? AND m.estado = 'A' AND p.estado = 'A'
       AND (m.tipo_motorista = 'FIJO' OR DAYOFWEEK(?) IN (1,7))
     ORDER BY p.nombres`,
    [fecha, fecha, sucursalId, fecha]
  );

  res.json({ sinPlanificacion: false, motoristas: rows.map((r) => ({ ...r, disponible: !!r.disponible })) });
}));

// GET /api/asignaciones/buscar-otro-cad?sucursalId=&fecha=&q=
// Motoristas de OTRAS sucursales, para cubrir emergencia (tipo APOYO)
// en el CAD que se está viendo. Se muestran TODOS los que coincidan
// con la búsqueda (activos), no solo los libres — así el supervisor ve
// también por qué alguien no se puede agregar. Solo bloquea tener un
// turno ABIERTO en otro CAD (ingreso marcado hoy sin salida todavía);
// si ya cerró turno en su CAD de origen, puede cubrir en este sin
// problema el mismo día.
router.get('/buscar-otro-cad', requireAccesoSucursal((req) => req.query.sucursalId), asyncHandler(async (req, res) => {
  const { sucursalId, fecha, q = '' } = req.query;

  const [rows] = await pool.query(
    `SELECT m.persona_id AS motoristaId, CONCAT(p.nombres,' ',p.apellidos) AS nombre,
            s.nombre AS sucursalBase, m.tipo_motorista AS tipoMotorista,
            (SELECT s2.nombre
               FROM asignacion a2
               JOIN asistencia_marca ing2
                 ON ing2.asignacion_id = a2.asignacion_id
                AND ing2.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'INGRESO')
                AND DATE(ing2.fecha_hora) = ?
               LEFT JOIN asistencia_marca sal2
                 ON sal2.asignacion_id = a2.asignacion_id
                AND sal2.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'SALIDA')
                AND DATE(sal2.fecha_hora) = ?
               JOIN sucursal s2 ON s2.sucursal_id = a2.sucursal_id
              WHERE a2.motorista_id = m.persona_id AND sal2.marca_id IS NULL
              LIMIT 1) AS cadConIngresoAbierto
     FROM motorista m
     JOIN persona p ON p.persona_id = m.persona_id
     JOIN sucursal s ON s.sucursal_id = p.sucursal_base_id
     WHERE p.sucursal_base_id <> ? AND m.estado = 'A' AND p.estado = 'A'
       AND CONCAT(p.nombres,' ',p.apellidos) LIKE CONCAT('%', ?, '%')
     ORDER BY p.nombres
     LIMIT 20`,
    [fecha, fecha, sucursalId, q]
  );

  res.json(rows.map((r) => ({ ...r, disponible: !r.cadConIngresoAbierto })));
}));

// POST /api/asignaciones/lote  { sucursalId, fechaInicio, fechaFin, tipo, motoristaIds: [] }
// Asigna y, de una vez, marca el ingreso de asistencia de cada motorista
// recién asignado (así el supervisor no tiene que repetir el paso en
// la pantalla de Asistencia).
router.post('/lote',
  requireRole('Supervisor', 'Gerente'),
  requireAccesoSucursal((req) => req.body.sucursalId),
  asyncHandler(async (req, res) => {
    const { sucursalId, fechaInicio, fechaFin, tipo, motoristaIds } = req.body;
    if (!Array.isArray(motoristaIds) || motoristaIds.length === 0) {
      return res.status(400).json({ error: 'Selecciona al menos un motorista.' });
    }
    if (!(await existePlanificacion(sucursalId, fechaInicio))) {
      return res.status(409).json({ error: 'Primero registra la planificación de este CAD para esta fecha en Planificación.' });
    }
    await callProcedure('sp_asignar_motoristas_lote', [
      motoristaIds.join(','), sucursalId, fechaInicio, fechaFin, tipo, req.user.usuarioId
    ]);

    const [creadas] = await pool.query(
      `SELECT asignacion_id FROM asignacion
       WHERE sucursal_id = ? AND fecha_inicio = ? AND fecha_fin = ? AND tipo_asignacion = ?
         AND estado = 'A' AND motorista_id IN (?)`,
      [sucursalId, fechaInicio, fechaFin, tipo, motoristaIds]
    );
    for (const { asignacion_id } of creadas) {
      await callProcedure('sp_marcar_ingreso', [asignacion_id, req.user.usuarioId]);
    }

    res.status(201).json({ ok: true, asignados: creadas.length, conIngreso: creadas.length });
  })
);

// GET /api/asignaciones?sucursalId=  (activas hoy, con estado de ingreso)
router.get('/', requireAccesoSucursal((req) => req.query.sucursalId), asyncHandler(async (req, res) => {
  const { sucursalId } = req.query;
  const [rows] = await pool.query(
    `SELECT a.asignacion_id AS asignacionId, p.codigo_interno AS codigo,
            CONCAT(p.nombres,' ',p.apellidos) AS nombre,
            a.tipo_asignacion AS tipoAsignacion,
            EXISTS (
              SELECT 1 FROM asistencia_marca am
              WHERE am.asignacion_id = a.asignacion_id
                AND am.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'INGRESO')
                AND DATE(am.fecha_hora) = CURDATE()
            ) AS marcoIngreso,
            (SELECT TIME_FORMAT(am.fecha_hora, '%H:%i') FROM asistencia_marca am
              WHERE am.asignacion_id = a.asignacion_id
                AND am.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'INGRESO')
                AND DATE(am.fecha_hora) = CURDATE() LIMIT 1) AS horaIngreso,
            EXISTS (
              SELECT 1 FROM asistencia_marca am
              WHERE am.asignacion_id = a.asignacion_id
                AND am.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'SALIDA')
                AND DATE(am.fecha_hora) = CURDATE()
            ) AS cerroTurno
     FROM asignacion a
     JOIN motorista m ON m.persona_id = a.motorista_id
     JOIN persona p ON p.persona_id = m.persona_id
     WHERE a.sucursal_id = ? AND a.estado = 'A' AND CURDATE() BETWEEN a.fecha_inicio AND a.fecha_fin
     ORDER BY p.nombres`,
    [sucursalId]
  );
  res.json(rows.map((r) => ({ ...r, marcoIngreso: !!r.marcoIngreso, cerroTurno: !!r.cerroTurno })));
}));

// POST /api/asignaciones/:id/anular
router.post('/:id/anular', requireRole('Supervisor', 'Gerente'), asyncHandler(async (req, res) => {
  await callProcedure('sp_anular_asignacion', [req.params.id]);
  res.json({ ok: true });
}));

export default router;
