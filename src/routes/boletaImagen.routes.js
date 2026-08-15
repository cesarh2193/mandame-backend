import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { pool } from '../config/db.js';
import { authenticate, requireRole, tieneAccesoSucursal, esAdministrador } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { obtenerMotoristasBoleta } from './informes.routes.js';
import { subirBoletaADrive, renombrarBoletaEnDrive } from '../utils/googleDrive.js';

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
// boleta de ese motorista para esa fecha, NO se borra: se renombra
// (local y en Drive) marcándola como reemplazada, y la nueva queda
// como la boleta activa — así queda bitácora de que hubo un
// reemplazo, sin perder la que subieron antes.
//
// Seguridad: solo se puede subir/reemplazar la boleta del día de
// hoy — nunca la de una fecha pasada (o futura) — salvo que quien
// sube sea Administrador, que sí puede corregir boletas de otros
// días. Esto evita que el resto de roles altere el registro de un
// día ya cerrado. La validación se hace acá, no solo en el
// frontend, porque el frontend es fácil de saltarse llamando la API
// directo.
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

    if (!esAdministrador(req)) {
      const [[{ hoy }]] = await pool.query('SELECT CURDATE() AS hoy');
      if (fecha !== hoy) {
        // multer ya guardó el archivo en disco antes de llegar acá —
        // si se rechaza la subida, no lo dejamos huérfano.
        fs.unlink(req.file.path, () => {});
        return res.status(403).json({ error: 'Solo se puede subir o reemplazar la boleta del día de hoy.' });
      }
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
      const marca = `reemplazada ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;

      // Local: se renombra, no se borra — queda en el disco como copia.
      const extAnterior = path.extname(existente.archivo_local);
      const nombreLocalNuevo = `${existente.archivo_local.slice(0, -extAnterior.length)}-${marca.replace(/[: ]/g, '-')}${extAnterior}`;
      fs.rename(
        path.join(UPLOADS_BOLETAS_DIR, existente.archivo_local),
        path.join(UPLOADS_BOLETAS_DIR, nombreLocalNuevo),
        () => {}
      );

      // Drive: mismo criterio, se renombra el archivo anterior en vez
      // de sobrescribirlo.
      if (existente.drive_file_id) {
        const nombreDriveAnterior = `${persona?.nombre || 'Motorista'} - ${fecha} (${marca})${extAnterior}`;
        await renombrarBoletaEnDrive(existente.drive_file_id, nombreDriveAnterior);
      }
    }

    const ext = path.extname(req.file.filename);
    const nombreDrive = `${persona?.nombre || 'Motorista'} - ${fecha}${ext}`;

    const resultadoDrive = await subirBoletaADrive({
      rutaLocal: req.file.path,
      nombreArchivo: nombreDrive,
      mimeType: req.file.mimetype,
      fecha,
      cad: sucursal?.nombre || 'CAD'
    });

    if (existente) {
      // Ojo: si la subida a Drive falló, NO se debe caer de vuelta al
      // drive_file_id anterior — ese archivo ya quedó renombrado como
      // "reemplazada" y seguir apuntándolo confundiría al abrir "Ver
      // boleta" (mostraría la vieja con nombre de reemplazada). Queda
      // en null hasta que se vuelva a intentar subir.
      await pool.query(
        `UPDATE boleta_motorista
         SET archivo_local = ?, drive_file_id = ?, drive_web_link = ?, usuario_id = ?, sucursal_id = ?, actualizado_en = NOW()
         WHERE boleta_id = ?`,
        [
          req.file.filename,
          resultadoDrive?.driveFileId ?? null,
          resultadoDrive?.driveWebLink ?? null,
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
