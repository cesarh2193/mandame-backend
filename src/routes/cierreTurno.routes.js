import { Router } from 'express';
import { pool, callProcedure } from '../config/db.js';
import { authenticate, requireRole, requireAccesoSucursal, esAdministrador } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { autorizarYNotificar } from '../services/autorizacion.service.js';

const router = Router();
router.use(authenticate);

// GET /api/cierre-turno/en-turno?sucursalId=
// Motoristas que ya marcaron ingreso hoy y todavía no tienen salida.
router.get('/en-turno', requireAccesoSucursal((req) => req.query.sucursalId), asyncHandler(async (req, res) => {
  const { sucursalId } = req.query;
  const [rows] = await pool.query(
    `SELECT a.asignacion_id AS asignacionId, CONCAT(p.nombres,' ',p.apellidos) AS nombre,
            s.nombre AS sucursal,
            TIME_FORMAT(ing.fecha_hora, '%H:%i') AS horaIngreso
     FROM asignacion a
     JOIN motorista m ON m.persona_id = a.motorista_id
     JOIN persona p ON p.persona_id = m.persona_id
     JOIN sucursal s ON s.sucursal_id = a.sucursal_id
     JOIN asistencia_marca ing
       ON ing.asignacion_id = a.asignacion_id
      AND ing.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'INGRESO')
      AND DATE(ing.fecha_hora) = CURDATE()
     LEFT JOIN asistencia_marca sal
       ON sal.asignacion_id = a.asignacion_id
      AND sal.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'SALIDA')
      AND DATE(sal.fecha_hora) = CURDATE()
     WHERE a.sucursal_id = ? AND sal.marca_id IS NULL
     ORDER BY ing.fecha_hora`,
    [sucursalId]
  );
  res.json(rows);
}));

// POST /api/cierre-turno/:asignacionId
// Un solo paso: corrige el ingreso si vino editado, guarda la
// salida + los repartos (sp_cerrar_turno, con hora de salida editable)
// y, si quien guarda tiene permiso para autorizar (Supervisor/Gerente/
// Admin), de una vez autoriza ese cierre (sp_autorizar_repartos + correo
// a Gerentes) — así ya no hace falta pasar por la pantalla de Autorizar.
// Un Digitador o el propio Motorista pueden cerrar su turno igual,
// pero ese cierre queda PENDIENTE hasta que un Supervisor lo autorice,
// tal como ya funcionaba antes.
router.post('/:asignacionId', requireRole('Supervisor', 'Digitador', 'Gerente', 'Motorista'), asyncHandler(async (req, res) => {
  const { cantidadEntregas, tarifaId, esExtra = false, observacion = null, horaIngreso, horaSalida } = req.body;
  const puedeAutorizar = req.user?.roles?.some((r) => ['Supervisor', 'Gerente', 'Admin'].includes(r));

  if (horaIngreso) {
    await callProcedure('sp_corregir_ingreso', [req.params.asignacionId, horaIngreso, req.user.usuarioId]);
  }

  const [repartoRow] = await callProcedure('sp_cerrar_turno', [
    req.params.asignacionId, cantidadEntregas, tarifaId, null, esExtra ? 1 : 0, observacion,
    req.user.usuarioId, horaSalida || null
  ]);

  if (!puedeAutorizar) {
    return res.status(201).json({ ok: true, autorizado: false });
  }

  const { autorizados, correosEnviados } = await autorizarYNotificar([repartoRow.repartoId], req.user.usuarioId);
  res.status(201).json({ ok: true, autorizado: true, autorizados, correosEnviados });
}));

// PUT /api/cierre-turno/reparto/:repartoId — solo Administrador
// Único camino para corregir hora de salida y/o cantidad de un
// cierre ya guardado (sp_corregir_cierre, con su propio registro
// en auditoria).
router.put('/reparto/:repartoId', asyncHandler(async (req, res) => {
  if (!esAdministrador(req)) {
    return res.status(403).json({ error: 'Solo un Administrador puede corregir un cierre ya guardado.' });
  }
  const { cantidadEntregas, horaSalida } = req.body;
  await callProcedure('sp_corregir_cierre', [req.params.repartoId, cantidadEntregas, horaSalida, req.user.usuarioId]);
  res.json({ ok: true });
}));

export default router;
