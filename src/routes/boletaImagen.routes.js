import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../config/db.js';
import { authenticate, requireRole, tieneAccesoSucursal, esAdministrador } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { obtenerMotoristasBoleta } from './informes.routes.js';
import { guardarBoletaMotorista } from '../services/boleta.service.js';
import { UPLOADS_BOLETAS_DIR, uploadBoleta } from '../config/uploadsBoleta.js';

export { UPLOADS_BOLETAS_DIR };

const router = Router();
router.use(authenticate);

// true si el usuario solo tiene el rol Motorista (ningún rol elevado
// combinado) — a ese perfil se le restringe todo a "lo suyo": solo ve y
// solo puede subir/reemplazar su propia boleta.
function esMotoristaPuro(req) {
  const roles = req.user?.roles ?? [];
  return roles.length > 0 && roles.every((r) => r === 'Motorista');
}

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

  let resultado = motoristas.map((m) => ({
    ...m,
    estado: cargadas.has(m.motoristaId) ? 'CARGADA' : 'PENDIENTE'
  }));

  if (esMotoristaPuro(req)) {
    resultado = resultado.filter((m) => Number(m.motoristaId) === Number(req.user.motoristaId));
  }

  res.json(resultado);
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
  requireRole('Supervisor', 'Digitador', 'Gerente', 'Motorista'),
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

    if (esMotoristaPuro(req) && motoristaId !== Number(req.user.motoristaId)) {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'Solo puedes subir tu propia boleta.' });
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

    const { subidaDrive } = await guardarBoletaMotorista({
      motoristaId, sucursalId, fecha, archivo: req.file, usuarioId: req.user.usuarioId
    });

    res.json({ ok: true, subidaDrive });
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
  if (esMotoristaPuro(req) && Number(req.params.motoristaId) !== Number(req.user.motoristaId)) {
    return res.status(403).json({ error: 'Solo puedes ver tu propia boleta.' });
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
