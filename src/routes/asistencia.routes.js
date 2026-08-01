import { Router } from 'express';
import { pool, callProcedure } from '../config/db.js';
import { authenticate, requireRole, requireAccesoSucursal, esAdministrador } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(authenticate);

// GET /api/asistencia/pendientes?sucursalId=
router.get('/pendientes', requireAccesoSucursal((req) => req.query.sucursalId), asyncHandler(async (req, res) => {
  const { sucursalId } = req.query;
  const [rows] = await pool.query(
    `SELECT a.asignacion_id AS asignacionId, CONCAT(p.nombres,' ',p.apellidos) AS nombre,
            m.tipo_motorista AS tipoMotorista
     FROM asignacion a
     JOIN motorista m ON m.persona_id = a.motorista_id
     JOIN persona p ON p.persona_id = m.persona_id
     WHERE a.sucursal_id = ? AND a.estado = 'A' AND CURDATE() BETWEEN a.fecha_inicio AND a.fecha_fin
       AND NOT EXISTS (
         SELECT 1 FROM asistencia_marca am
         WHERE am.asignacion_id = a.asignacion_id
           AND am.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'INGRESO')
           AND DATE(am.fecha_hora) = CURDATE()
       )
     ORDER BY p.nombres`,
    [sucursalId]
  );
  res.json(rows);
}));

// POST /api/asistencia/:id/ingreso
router.post('/:id/ingreso', requireRole('Supervisor', 'Digitador', 'Gerente'), asyncHandler(async (req, res) => {
  await callProcedure('sp_marcar_ingreso', [req.params.id, req.user.usuarioId]);
  res.json({ ok: true });
}));

// PUT /api/asistencia/:id/ingreso — corrige la hora de ingreso de hoy.
// Solo Administrador, igual que la corrección de hora de salida de
// un cierre ya guardado (ver PUT /cierre-turno/reparto/:repartoId).
router.put('/:id/ingreso', asyncHandler(async (req, res) => {
  if (!esAdministrador(req)) {
    return res.status(403).json({ error: 'Solo un Administrador puede corregir la hora de ingreso.' });
  }
  const { fechaHora } = req.body;
  await callProcedure('sp_corregir_ingreso', [req.params.id, fechaHora, req.user.usuarioId]);
  res.json({ ok: true });
}));

export default router;
