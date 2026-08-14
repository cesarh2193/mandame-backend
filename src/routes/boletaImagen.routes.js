import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { pool } from '../config/db.js';
import { authenticate, requireRole, tieneAccesoSucursal } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { obtenerMotoristasBoleta } from './informes.routes.js';
import { subirBoletaADrive } from '../utils/googleDrive.js';

const router = Router();
router.use(authenticate);

export const UPLOADS_BOLETAS_DIR = path.resolve(process.cwd(), 'uploads', 'boletas');
fs.mkdirSync(UPLOADS_BOLETAS_DIR, { recursive: true });

const EXTENSIONES_BOLETA = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const uploadBoleta = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_BOLETAS_DIR),
    filename: (req, file, cb) => {
      const ext = EXTENSIONES_BOLETA[file.mimetype] || path.extname(file.originalname) || '.jpg';
      cb(null, `${req.params.motoristaId}-${req.query.fecha}-${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!EXTENSIONES_BOLETA[file.mimetype]) {
      return cb(new Error('Formato de imagen no soportado. Usa JPG, PNG o WEBP.'));
    }
    cb(null, true);
  }
});

// GET /api/boleta-imagen?fecha=&sucursalId=
// Mismo listado de motoristas que "Boletas cierre" (asistencia + cierre
// de turno autorizado ese día), con el estado de la boleta agregado.
router.get('/', asyncHandler(async (req, res) => {
  const { fecha, sucursalId } = req.query;
  if (!fecha || !sucursalId) {
    return res.status(400).json({ error: 'La fecha y el CAD son requeridos.' });
  }
  if (!tieneAccesoSucursal(req, sucursalId)) {
    return res.status(403).json({ error: 'No tienes acceso a esta sucursal.' });
  }

  const motoristas = await obtenerMotoristasBoleta(req, fecha, sucursalId);

  const [boletas] = await pool.query(
    'SELECT motorista_id AS motoristaId FROM boleta_motorista WHERE fecha = ? AND sucursal_id = ?',
    [fecha, Number(sucursalId)]
  );
  const cargadas = new Set(boletas.map((b) => b.motoristaId));

  res.json(motoristas.map((m) => ({
    ...m,
    estado: cargadas.has(m.motoristaId) ? 'CARGADA' : 'PENDIENTE'
  })));
}));

// POST /api/boleta-imagen/:motoristaId?fecha=&sucursalId=  (form-data: imagen)
// Guarda el archivo en el servidor y, si Drive está configurado, lo
// sube también dentro de <raíz>/<fecha>/<CAD>/. Si ya existe una
// boleta de ese motorista para esa fecha, la reemplaza (no duplica).
router.post(
  '/:motoristaId',
  requireRole('Supervisor', 'Digitador', 'Gerente'),
  uploadBoleta.single('imagen'),
  asyncHandler(async (req, res) => {
    const motoristaId = Number(req.params.motoristaId);
    const { fecha, sucursalId } = req.query;

    if (!fecha || !sucursalId) {
      return res.status(400).json({ error: 'La fecha y el CAD son requeridos.' });
    }
    if (!tieneAccesoSucursal(req, sucursalId)) {
      return res.status(403).json({ error: 'No tienes acceso a esta sucursal.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Debes adjuntar una imagen.' });
    }

    const [[persona]] = await pool.query(
      `SELECT CONCAT(p.nombres,' ',p.apellidos) AS nombre
       FROM motorista m JOIN persona p ON p.persona_id = m.persona_id
       WHERE m.persona_id = ?`,
      [motoristaId]
    );
    const [[sucursal]] = await pool.query('SELECT nombre FROM sucursal WHERE sucursal_id = ?', [Number(sucursalId)]);

    const [[existente]] = await pool.query(
      'SELECT * FROM boleta_motorista WHERE motorista_id = ? AND fecha = ?',
      [motoristaId, fecha]
    );

    if (existente) {
      fs.unlink(path.join(UPLOADS_BOLETAS_DIR, existente.archivo_local), () => {});
    }

    const ext = path.extname(req.file.filename);
    const nombreDrive = `${persona?.nombre || 'Motorista'} - ${fecha}${ext}`;

    const resultadoDrive = await subirBoletaADrive({
      rutaLocal: req.file.path,
      nombreArchivo: nombreDrive,
      mimeType: req.file.mimetype,
      fecha,
      cad: sucursal?.nombre || 'CAD',
      driveFileIdExistente: existente?.drive_file_id || null
    });

    if (existente) {
      await pool.query(
        `UPDATE boleta_motorista
         SET archivo_local = ?, drive_file_id = ?, drive_web_link = ?, usuario_id = ?, sucursal_id = ?, actualizado_en = NOW()
         WHERE boleta_id = ?`,
        [
          req.file.filename,
          resultadoDrive?.driveFileId ?? existente.drive_file_id,
          resultadoDrive?.driveWebLink ?? existente.drive_web_link,
          req.user.usuarioId,
          Number(sucursalId),
          existente.boleta_id
        ]
      );
    } else {
      await pool.query(
        `INSERT INTO boleta_motorista
           (motorista_id, sucursal_id, fecha, archivo_local, drive_file_id, drive_web_link, usuario_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          motoristaId, Number(sucursalId), fecha, req.file.filename,
          resultadoDrive?.driveFileId ?? null, resultadoDrive?.driveWebLink ?? null, req.user.usuarioId
        ]
      );
    }

    res.json({ ok: true, subidaDrive: !!resultadoDrive });
  })
);

// GET /api/boleta-imagen/:motoristaId/archivo?fecha=
// Sirve la copia local de la boleta (requiere sesión, igual que el
// resto de la API) para poder mostrarla desde el navegador.
router.get('/:motoristaId/archivo', asyncHandler(async (req, res) => {
  const { fecha } = req.query;
  if (!fecha) {
    return res.status(400).json({ error: 'La fecha es requerida.' });
  }

  const [[boleta]] = await pool.query(
    'SELECT archivo_local FROM boleta_motorista WHERE motorista_id = ? AND fecha = ?',
    [Number(req.params.motoristaId), fecha]
  );
  if (!boleta) {
    return res.status(404).json({ error: 'No hay boleta cargada para esa fecha.' });
  }

  res.sendFile(path.join(UPLOADS_BOLETAS_DIR, boleta.archivo_local));
}));

export default router;
