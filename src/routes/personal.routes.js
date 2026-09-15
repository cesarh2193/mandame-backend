import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { pool } from '../config/db.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { TIPOS_DOCUMENTO_PERSONAL } from '../config/documentosPersonal.js';

const router = Router();
router.use(authenticate);

export const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads', 'personal');
export const DOCUMENTOS_DIR = path.join(UPLOADS_DIR, 'documentos');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(DOCUMENTOS_DIR, { recursive: true });

const EXTENSIONES_FOTO = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const EXTENSIONES_DOCUMENTO = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };
const TIPOS_DOCUMENTO = TIPOS_DOCUMENTO_PERSONAL.map((d) => d.tipo);

const uploadFoto = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = EXTENSIONES_FOTO[file.mimetype] || path.extname(file.originalname) || '.jpg';
      cb(null, `${req.params.id}-${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!EXTENSIONES_FOTO[file.mimetype]) {
      return cb(new Error('Formato de imagen no soportado. Usa JPG, PNG o WEBP.'));
    }
    cb(null, true);
  }
});

const uploadDocumento = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DOCUMENTOS_DIR),
    filename: (req, file, cb) => {
      const ext = EXTENSIONES_DOCUMENTO[file.mimetype] || path.extname(file.originalname) || '.pdf';
      cb(null, `${req.params.id}-${req.params.tipo}-${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!EXTENSIONES_DOCUMENTO[file.mimetype]) {
      return cb(new Error('Formato no soportado. Usa JPG, PNG o PDF.'));
    }
    cb(null, true);
  }
});

function validarTipoDocumento(req, res, next) {
  const tipo = String(req.params.tipo || '').toUpperCase();
  if (!TIPOS_DOCUMENTO.includes(tipo)) {
    return res.status(400).json({ error: `Tipo de documento inválido. Usa: ${TIPOS_DOCUMENTO.join(', ')}.` });
  }
  req.params.tipo = tipo;
  next();
}

// GET /api/personal?sinUsuario=true
// sinUsuario=true es exclusivo del selector "crear usuario": además de
// no tener cuenta todavía, solo tiene sentido ofrecer ahí personal con
// puesto Administrador, Gerente, Supervisor o Motorista (son los puestos
// que hoy necesitan iniciar sesión en el sistema — el Motorista solo para
// subir su boleta).
//
// Alcance por rol: Admin y Gerente ven todo el personal. Supervisor,
// Digitador y Motorista solo ven el personal de las sucursales (CAD)
// a las que tienen acceso (req.user.sucursalIds) — no el directorio
// completo de la empresa.
router.get('/', asyncHandler(async (req, res) => {
  const soloSinUsuario = req.query.sinUsuario === 'true';
  const veTodo = req.user.roles.includes('Admin') || req.user.roles.includes('Gerente');

  // Inactivo (I) y Eliminado (E) no deben aparecer en ningún lado del
  // sistema de aquí en adelante — se filtran siempre, sin depender de
  // ningún parámetro opcional que el frontend pudiera mandar o no.
  const condiciones = [`p.estado = 'A'`];
  const params = [];
  if (soloSinUsuario) {
    condiciones.push(`u.usuario_id IS NULL AND cp.nombre IN ('Administrador', 'Gerente', 'Supervisor', 'Motorista')`);
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
            s.sucursal_id AS sucursalId, s.codigo_cad AS codigoCad, s.nombre AS sucursalNombre, s.empresa_id AS empresaId,
            m.persona_id IS NOT NULL AS tambienMotorista,
            m.tipo_motorista AS tipoMotorista, m.placa, m.licencia, m.estado AS estadoMotorista,
            p.contacto_emergencia_nombre AS contactoEmergenciaNombre,
            p.contacto_emergencia_telefono AS contactoEmergenciaTelefono,
            p.contacto_emergencia_relacion AS contactoEmergenciaRelacion,
            p.numero_cuenta AS numeroCuenta, p.banco, p.tipo_cuenta AS tipoCuenta,
            p.igss, p.estado_civil AS estadoCivil, p.nombre_conyuge AS nombreConyuge,
            p.nombre_padre AS nombrePadre, p.nombre_madre AS nombreMadre,
            p.telefono, p.correo,
            p.fecha_inicio_labores AS fechaInicioLabores, p.fecha_fin_labores AS fechaFinLabores,
            p.seguro_vida AS seguroVida,
            p.foto_url IS NOT NULL AS tieneFoto
     FROM persona p
     JOIN catalogo_puesto cp ON cp.puesto_id = p.puesto_id
     LEFT JOIN sucursal s ON s.sucursal_id = p.sucursal_base_id
     LEFT JOIN motorista m ON m.persona_id = p.persona_id
     ${soloSinUsuario ? `LEFT JOIN usuario u ON u.persona_id = p.persona_id` : ''}
     ${where}
     ORDER BY p.nombres`,
    params
  );

  const documentosPorPersona = new Map();
  if (rows.length) {
    const [docs] = await pool.query(
      `SELECT persona_id AS personaId, tipo FROM persona_documento WHERE persona_id IN (?)`,
      [rows.map((p) => p.id)]
    );
    for (const d of docs) {
      if (!documentosPorPersona.has(d.personaId)) documentosPorPersona.set(d.personaId, []);
      documentosPorPersona.get(d.personaId).push(d.tipo);
    }
  }

  res.json(rows.map((p) => ({ ...p, documentosSubidos: documentosPorPersona.get(p.id) || [] })));
}));

// POST /api/personal
router.post('/', requireRole('Admin', 'Supervisor'), asyncHandler(async (req, res) => {
  const {
    nombres, apellidos, dpi, puesto, sucursalId,
    tambienMotorista, tipoMotorista, placa, licencia,
    contactoEmergenciaNombre, contactoEmergenciaTelefono, contactoEmergenciaRelacion,
    numeroCuenta, banco, tipoCuenta, igss, estadoCivil, nombreConyuge,
    nombrePadre, nombreMadre, telefono, correo,
    fechaInicioLabores, fechaFinLabores, seguroVida
  } = req.body;

  if (!nombres || !apellidos || !dpi || !puesto || !sucursalId) {
    return res.status(400).json({ error: 'nombres, apellidos, dpi, puesto y sucursalId son requeridos.' });
  }
  if (String(dpi).replace(/\D/g, '').length !== 13) {
    return res.status(400).json({ error: 'El DPI debe tener 13 dígitos.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // El código ya no lo escribe quien crea el registro — es un
    // correlativo automático que nunca se repite (ver
    // scripts/migrar-codigo-y-estado-personal.js). El UPDATE de la
    // siguiente línea, dentro de esta misma transacción, ya actúa como
    // bloqueo natural: si dos personas se crean al mismo tiempo, la
    // segunda espera a que la primera termine antes de tomar el
    // siguiente número.
    await conn.query(`UPDATE codigo_personal_contador SET ultimo_codigo = ultimo_codigo + 1 WHERE id = 1`);
    const [[{ ultimo_codigo: nuevoCodigo }]] = await conn.query(
      `SELECT ultimo_codigo FROM codigo_personal_contador WHERE id = 1`
    );

    const [result] = await conn.query(
      `INSERT INTO persona (
         codigo_interno, nombres, apellidos, dpi, puesto_id, sucursal_base_id, fecha_ingreso,
         contacto_emergencia_nombre, contacto_emergencia_telefono, contacto_emergencia_relacion,
         numero_cuenta, banco, tipo_cuenta, igss, estado_civil, nombre_conyuge,
         nombre_padre, nombre_madre, telefono, correo,
         fecha_inicio_labores, fecha_fin_labores, seguro_vida
       )
       VALUES (?, ?, ?, ?, (SELECT puesto_id FROM catalogo_puesto WHERE nombre = ?), ?, CURDATE(),
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nuevoCodigo, nombres, apellidos, dpi, puesto, sucursalId,
        contactoEmergenciaNombre || null, contactoEmergenciaTelefono || null, contactoEmergenciaRelacion || null,
        numeroCuenta || null, banco || null, tipoCuenta || null, igss || null, estadoCivil || null, nombreConyuge || null,
        nombrePadre || null, nombreMadre || null, telefono || null, correo || null,
        fechaInicioLabores || null, fechaFinLabores || null, seguroVida ? 1 : 0
      ]
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
    tambienMotorista, tipoMotorista, placa, licencia, motoristaHabilitado,
    contactoEmergenciaNombre, contactoEmergenciaTelefono, contactoEmergenciaRelacion,
    numeroCuenta, banco, tipoCuenta, igss, estadoCivil, nombreConyuge,
    nombrePadre, nombreMadre, telefono, correo,
    fechaInicioLabores, fechaFinLabores, seguroVida
  } = req.body;
  const personaId = req.params.id;

  if (dpi && String(dpi).replace(/\D/g, '').length !== 13) {
    return res.status(400).json({ error: 'El DPI debe tener 13 dígitos.' });
  }

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
         estado = COALESCE(?, estado),
         contacto_emergencia_nombre = ?,
         contacto_emergencia_telefono = ?,
         contacto_emergencia_relacion = ?,
         numero_cuenta = ?,
         banco = ?,
         tipo_cuenta = ?,
         igss = ?,
         estado_civil = ?,
         nombre_conyuge = ?,
         nombre_padre = ?,
         nombre_madre = ?,
         telefono = ?,
         correo = ?,
         fecha_inicio_labores = ?,
         fecha_fin_labores = ?,
         seguro_vida = ?
       WHERE persona_id = ?`,
      [
        nombres, apellidos, dpi, puesto, sucursalId, estado,
        contactoEmergenciaNombre || null, contactoEmergenciaTelefono || null, contactoEmergenciaRelacion || null,
        numeroCuenta || null, banco || null, tipoCuenta || null, igss || null, estadoCivil || null, nombreConyuge || null,
        nombrePadre || null, nombreMadre || null, telefono || null, correo || null,
        fechaInicioLabores || null, fechaFinLabores || null, seguroVida ? 1 : 0,
        personaId
      ]
    );

    if (tambienMotorista === true) {
      // motoristaHabilitado controla motorista.estado (A/I) — un campo
      // aparte de persona.estado que decide si aparece como candidato en
      // Asignaciones. Antes no se podía ver ni tocar desde acá, así que
      // algunos quedaban inactivos ahí sin que nadie lo notara.
      const estadoMotorista = motoristaHabilitado === false ? 'I' : 'A';
      await conn.query(
        `INSERT INTO motorista (persona_id, licencia, placa, tipo_motorista, estado)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE licencia = VALUES(licencia), placa = VALUES(placa), tipo_motorista = VALUES(tipo_motorista), estado = VALUES(estado)`,
        [personaId, licencia || null, placa || null, tipoMotorista || 'FIJO', estadoMotorista]
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

// POST /api/personal/:id/foto — sube/reemplaza la foto de la persona.
router.post('/:id/foto', requireRole('Admin', 'Supervisor'), uploadFoto.single('foto'), asyncHandler(async (req, res) => {
  const personaId = req.params.id;
  if (!req.file) {
    return res.status(400).json({ error: 'No se recibió ningún archivo.' });
  }

  const [[persona]] = await pool.query('SELECT foto_url AS fotoUrl FROM persona WHERE persona_id = ?', [personaId]);
  if (!persona) {
    fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: 'Personal no encontrado.' });
  }

  if (persona.fotoUrl) {
    fs.unlink(path.join(UPLOADS_DIR, persona.fotoUrl), () => {});
  }

  await pool.query('UPDATE persona SET foto_url = ? WHERE persona_id = ?', [req.file.filename, personaId]);
  res.json({ ok: true });
}));

// GET /api/personal/:id/foto — sirve el archivo de foto de la persona (requiere sesión, igual que el resto de la API).
router.get('/:id/foto', asyncHandler(async (req, res) => {
  const personaId = req.params.id;
  const [[persona]] = await pool.query('SELECT foto_url AS fotoUrl FROM persona WHERE persona_id = ?', [personaId]);
  if (!persona?.fotoUrl) {
    return res.status(404).json({ error: 'Esta persona no tiene foto registrada.' });
  }
  res.sendFile(path.join(UPLOADS_DIR, persona.fotoUrl));
}));

// POST /api/personal/:id/documentos/:tipo — sube/reemplaza un documento (DPI, RECIBO_LUZ, LICENCIA).
router.post('/:id/documentos/:tipo', requireRole('Admin', 'Supervisor'), validarTipoDocumento, uploadDocumento.single('documento'), asyncHandler(async (req, res) => {
  const personaId = req.params.id;
  const tipo = req.params.tipo;
  if (!req.file) {
    return res.status(400).json({ error: 'No se recibió ningún archivo.' });
  }

  const [[existente]] = await pool.query(
    'SELECT archivo_nombre AS archivoNombre FROM persona_documento WHERE persona_id = ? AND tipo = ?',
    [personaId, tipo]
  );
  if (existente) {
    fs.unlink(path.join(DOCUMENTOS_DIR, existente.archivoNombre), () => {});
  }

  await pool.query(
    `INSERT INTO persona_documento (persona_id, tipo, archivo_nombre)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE archivo_nombre = VALUES(archivo_nombre), fecha_subida = CURRENT_TIMESTAMP`,
    [personaId, tipo, req.file.filename]
  );
  res.json({ ok: true });
}));

// GET /api/personal/:id/documentos/:tipo — sirve el archivo del documento (requiere sesión).
router.get('/:id/documentos/:tipo', validarTipoDocumento, asyncHandler(async (req, res) => {
  const personaId = req.params.id;
  const tipo = req.params.tipo;
  const [[documento]] = await pool.query(
    'SELECT archivo_nombre AS archivoNombre FROM persona_documento WHERE persona_id = ? AND tipo = ?',
    [personaId, tipo]
  );
  if (!documento) {
    return res.status(404).json({ error: 'Este documento no ha sido subido.' });
  }
  res.sendFile(path.join(DOCUMENTOS_DIR, documento.archivoNombre));
}));

export default router;
