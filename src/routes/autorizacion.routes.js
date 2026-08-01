import { Router } from 'express';
import { pool } from '../config/db.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { autorizarYNotificar } from '../services/autorizacion.service.js';

const router = Router();
router.use(authenticate);

// GET /api/autorizacion/pendientes?sucursalId=
// Solo el día de hoy — un cierre de un día anterior ya no aparece
// aquí, aparece en /autorizados en modo consulta.
router.get('/pendientes', asyncHandler(async (req, res) => {
  const { sucursalId } = req.query;
  const [rows] = await pool.query(
    `SELECT r.reparto_id AS repartoId, CONCAT(p.nombres,' ',p.apellidos) AS nombre,
            r.cantidad_entregas AS entregas, (r.estado = 'PENDIENTE') AS cerrado
     FROM reparto r
     JOIN asignacion a ON a.asignacion_id = r.asignacion_id
     JOIN motorista m ON m.persona_id = a.motorista_id
     JOIN persona p ON p.persona_id = m.persona_id
     WHERE a.sucursal_id = ? AND r.fecha = CURDATE() AND r.estado = 'PENDIENTE'
     ORDER BY p.nombres`,
    [sucursalId]
  );
  res.json(rows.map((r) => ({ ...r, cerrado: !!r.cerrado })));
}));

// GET /api/autorizacion/autorizados?sucursalId=&fecha=  (modo consulta)
router.get('/autorizados', asyncHandler(async (req, res) => {
  const { sucursalId, fecha } = req.query;
  const [rows] = await pool.query(
    `SELECT r.reparto_id AS repartoId, CONCAT(p.nombres,' ',p.apellidos) AS nombre,
            r.cantidad_entregas AS entregas,
            (SELECT TIME_FORMAT(am.fecha_hora, '%H:%i') FROM asistencia_marca am
              WHERE am.asignacion_id = r.asignacion_id
                AND am.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'INGRESO')
              ORDER BY am.fecha_hora DESC LIMIT 1) AS horaIngreso,
            (SELECT TIME_FORMAT(am.fecha_hora, '%H:%i') FROM asistencia_marca am
              WHERE am.asignacion_id = r.asignacion_id
                AND am.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'SALIDA')
              ORDER BY am.fecha_hora DESC LIMIT 1) AS horaSalida
     FROM reparto r
     JOIN asignacion a ON a.asignacion_id = r.asignacion_id
     JOIN motorista m ON m.persona_id = a.motorista_id
     JOIN persona p ON p.persona_id = m.persona_id
     WHERE a.sucursal_id = ? AND r.fecha = ? AND r.estado = 'AUTORIZADO'
     ORDER BY r.fecha_autoriza DESC`,
    [sucursalId, fecha]
  );
  res.json(rows);
}));

// POST /api/autorizacion/autorizar  { repartoIds: [] }
// Llama sp_autorizar_repartos, que además de marcar los repartos
// devuelve los correos de los Gerentes con acceso a esa(s)
// sucursal(es) — este endpoint es el único responsable de mandar
// el correo de verdad; el procedimiento solo entrega la lista.
router.post('/autorizar', requireRole('Supervisor', 'Gerente'), asyncHandler(async (req, res) => {
  const { repartoIds } = req.body;
  if (!Array.isArray(repartoIds) || repartoIds.length === 0) {
    return res.status(400).json({ error: 'Selecciona al menos un cierre para autorizar.' });
  }

  const { autorizados, correosEnviados } = await autorizarYNotificar(repartoIds, req.user.usuarioId);
  res.json({ ok: true, autorizados, correosEnviados });
}));

export default router;
