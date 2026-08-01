import { Router } from 'express';
import { pool } from '../config/db.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(authenticate);

// GET /api/personal?sinUsuario=true
// sinUsuario=true es exclusivo del selector "crear usuario": además de
// no tener cuenta todavía, solo tiene sentido ofrecer ahí personal con
// puesto Administrador, Gerente o Supervisor (son los puestos que hoy
// necesitan iniciar sesión en el sistema).
//
// Alcance por rol: Admin y Gerente ven todo el personal. Supervisor,
// Digitador y Motorista solo ven el personal de las sucursales (CAD)
// a las que tienen acceso (req.user.sucursalIds) — no el directorio
// completo de la empresa.
router.get('/', asyncHandler(async (req, res) => {
  const soloSinUsuario = req.query.sinUsuario === 'true';
  const veTodo = req.user.roles.includes('Admin') || req.user.roles.includes('Gerente');

  const condiciones = [];
  const params = [];
  if (soloSinUsuario) {
    condiciones.push(`u.usuario_id IS NULL AND cp.nombre IN ('Administrador', 'Gerente', 'Supervisor')`);
  }
  if (!veTodo) {
    const sucursalIds = req.user.sucursalIds || [];
    condiciones.push(`p.sucursal_base_id IN (?)`);
    params.push(sucursalIds.length ? sucursalIds : [0]);
  }
  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

  const [rows] = await pool.query(
    `SELECT p.persona_id AS id, p.codigo_interno AS codigo,
            p.nombres AS nombrePila, p.apellidos AS apellidoPila,
            CONCAT(p.nombres,' ',p.apellidos) AS nombres,
            p.dpi, p.estado,
            cp.nombre AS puesto,
            s.sucursal_id AS sucursalId, s.nombre AS sucursalNombre, s.empresa_id AS empresaId,
            m.persona_id IS NOT NULL AS tambienMotorista,
            m.tipo_motorista AS tipoMotorista, m.placa, m.licencia
     FROM persona p
     JOIN catalogo_puesto cp ON cp.puesto_id = p.puesto_id
     LEFT JOIN sucursal s ON s.sucursal_id = p.sucursal_base_id
     LEFT JOIN motorista m ON m.persona_id = p.persona_id
     ${soloSinUsuario ? `LEFT JOIN usuario u ON u.persona_id = p.persona_id` : ''}
     ${where}
     ORDER BY p.nombres`,
    params
  );
  res.json(rows);
}));

// POST /api/personal
router.post('/', requireRole('Admin', 'Supervisor'), asyncHandler(async (req, res) => {
  const {
    codigo, nombres, apellidos, dpi, puesto, sucursalId,
    tambienMotorista, tipoMotorista, placa, licencia
  } = req.body;

  if (!nombres || !apellidos || !dpi || !puesto || !sucursalId) {
    return res.status(400).json({ error: 'codigo, nombres, apellidos, dpi, puesto y sucursalId son requeridos.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.query(
      `INSERT INTO persona (codigo_interno, nombres, apellidos, dpi, puesto_id, sucursal_base_id, fecha_ingreso)
       VALUES (?, ?, ?, ?, (SELECT puesto_id FROM catalogo_puesto WHERE nombre = ?), ?, CURDATE())`,
      [codigo, nombres, apellidos, dpi, puesto, sucursalId]
    );
    const personaId = result.insertId;

    if (tambienMotorista) {
      await conn.query(
        `INSERT INTO motorista (persona_id, licencia, placa, tipo_motorista) VALUES (?, ?, ?, ?)`,
        [personaId, licencia || null, placa || null, tipoMotorista || 'FIJO']
      );
    }

    await conn.commit();
    res.status(201).json({ id: personaId });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

// PUT /api/personal/:id
router.put('/:id', requireRole('Admin', 'Supervisor'), asyncHandler(async (req, res) => {
  const {
    nombres, apellidos, dpi, puesto, sucursalId, estado,
    tambienMotorista, tipoMotorista, placa, licencia
  } = req.body;
  const personaId = req.params.id;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `UPDATE persona SET
         nombres = COALESCE(?, nombres),
         apellidos = COALESCE(?, apellidos),
         dpi = COALESCE(?, dpi),
         puesto_id = COALESCE((SELECT puesto_id FROM catalogo_puesto WHERE nombre = ?), puesto_id),
         sucursal_base_id = COALESCE(?, sucursal_base_id),
         estado = COALESCE(?, estado)
       WHERE persona_id = ?`,
      [nombres, apellidos, dpi, puesto, sucursalId, estado, personaId]
    );

    if (tambienMotorista === true) {
      await conn.query(
        `INSERT INTO motorista (persona_id, licencia, placa, tipo_motorista)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE licencia = VALUES(licencia), placa = VALUES(placa), tipo_motorista = VALUES(tipo_motorista)`,
        [personaId, licencia || null, placa || null, tipoMotorista || 'FIJO']
      );
    } else if (tambienMotorista === false) {
      await conn.query(`DELETE FROM motorista WHERE persona_id = ?`, [personaId]);
    }

    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

// POST /api/personal/:id/dar-de-baja
// No se permite si la persona (como motorista) tiene una asignación
// activa hoy Y ya marcó ingreso hoy — es decir, si está en pleno
// turno ahora mismo.
router.post('/:id/dar-de-baja', requireRole('Admin', 'Supervisor'), asyncHandler(async (req, res) => {
  const personaId = req.params.id;

  const [[{ enTurnoHoy }]] = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM asignacion a
       JOIN asistencia_marca am
         ON am.asignacion_id = a.asignacion_id
        AND am.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'INGRESO')
        AND DATE(am.fecha_hora) = CURDATE()
       WHERE a.motorista_id = ? AND a.estado = 'A' AND CURDATE() BETWEEN a.fecha_inicio AND a.fecha_fin
     ) AS enTurnoHoy`,
    [personaId]
  );

  if (enTurnoHoy) {
    return res.status(409).json({ error: 'No se puede dar de baja: tiene asignación y asistencia registradas hoy.' });
  }

  await pool.query(`UPDATE persona SET estado = 'I' WHERE persona_id = ?`, [personaId]);
  res.json({ ok: true });
}));

export default router;
