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
            pl.motoristas_plan AS total, u.usuario AS registradoPor,
            EXISTS (
              SELECT 1 FROM asignacion a
              JOIN asistencia_marca am ON am.asignacion_id = a.asignacion_id
                AND am.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'INGRESO')
                AND DATE(am.fecha_hora) = pl.fecha
              WHERE a.sucursal_id = pl.sucursal_id
            ) AS tieneAsistencia
     FROM planificacion pl
     JOIN sucursal s ON s.sucursal_id = pl.sucursal_id
     LEFT JOIN usuario u ON u.usuario_id = pl.usuario_crea_id
     WHERE pl.fecha = ? ${esAdmin ? '' : 'AND pl.sucursal_id IN (?)'}`,
    esAdmin ? [fecha] : [fecha, sucursalIds.length ? sucursalIds : [0]]
  );
  res.json(rows.map((r) => ({ ...r, tieneAsistencia: !!r.tieneAsistencia })));
}));

// POST /api/planificacion  { sucursalId, fecha, total }
// Una vez que existe planificación para una sucursal+fecha, queda
// bloqueada: no se puede volver a guardar otra encima (antes el
// procedimiento hacía upsert y la sobrescribía en silencio). Para
// corregir una ya existente está el PUT de abajo.
router.post('/',
  requireRole('Supervisor', 'Gerente'),
  requireAccesoSucursal((req) => req.body.sucursalId),
  asyncHandler(async (req, res) => {
    const { sucursalId, fecha, total } = req.body;
    if (!(Number(total) > 0)) {
      return res.status(400).json({ error: 'El total de motoristas debe ser mayor a cero.' });
    }

    const [existentes] = await pool.query(
      `SELECT motoristas_plan AS total FROM planificacion WHERE sucursal_id = ? AND fecha = ?`,
      [sucursalId, fecha]
    );
    if (existentes.length > 0) {
      return res.status(409).json({
        error: `Ya existe una planificación para esta sucursal y fecha (${existentes[0].total} motoristas).`
      });
    }

    await callProcedure('sp_registrar_planificacion', [sucursalId, fecha, total, req.user.usuarioId]);
    res.status(201).json({ ok: true });
  })
);

// PUT /api/planificacion  { sucursalId, fecha, total }
// Corrige una planificación ya existente. A diferencia del POST, sí
// sobrescribe — la única validación de negocio es que el total sea
// mayor a cero; el permiso de rol/sucursal es el mismo que para crear.
router.put('/',
  requireRole('Supervisor', 'Gerente'),
  requireAccesoSucursal((req) => req.body.sucursalId),
  asyncHandler(async (req, res) => {
    const { sucursalId, fecha, total } = req.body;
    if (!(Number(total) > 0)) {
      return res.status(400).json({ error: 'El total de motoristas debe ser mayor a cero.' });
    }

    await callProcedure('sp_registrar_planificacion', [sucursalId, fecha, total, req.user.usuarioId]);
    res.json({ ok: true });
  })
);

// DELETE /api/planificacion?sucursalId=&fecha=
// Anula (borra) la planificación de un CAD/fecha. Solo se permite si
// todavía no hay ningún motorista con asistencia registrada ese día
// en ese CAD — si ya hay, se rechaza para no dejar a alguien que ya
// llegó a trabajar sin planificación de referencia.
router.delete('/',
  requireRole('Supervisor', 'Gerente'),
  requireAccesoSucursal((req) => req.query.sucursalId),
  asyncHandler(async (req, res) => {
    const { sucursalId, fecha } = req.query;
    if (!sucursalId || !fecha) {
      return res.status(400).json({ error: 'Sucursal y fecha son requeridas.' });
    }

    const [[{ tieneAsistencia }]] = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM asignacion a
         JOIN asistencia_marca am ON am.asignacion_id = a.asignacion_id
           AND am.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'INGRESO')
           AND DATE(am.fecha_hora) = ?
         WHERE a.sucursal_id = ?
       ) AS tieneAsistencia`,
      [fecha, sucursalId]
    );
    if (tieneAsistencia) {
      return res.status(409).json({
        error: 'No se puede anular: ya hay motoristas con asistencia registrada ese día en este CAD.'
      });
    }

    await pool.query('DELETE FROM planificacion WHERE sucursal_id = ? AND fecha = ?', [sucursalId, fecha]);
    res.json({ ok: true });
  })
);

export default router;
