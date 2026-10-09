import { Router } from 'express';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { pool } from '../config/db.js';
import { env } from '../config/env.js';
import { authenticate, requireRole, tieneAccesoSucursal, verificarTokenBoleta } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { obtenerMotoristasBoleta } from './informes.routes.js';
import { guardarBoletaMotorista } from '../services/boleta.service.js';
import { uploadBoleta } from '../config/uploadsBoleta.js';
import { convertirHeicSiCorresponde } from '../utils/imagenHeic.js';

const router = Router();

// POST /api/boletas/generar-link  { sucursalId, fecha }
// Genera un link para que un motorista sin cuenta suba su boleta desde
// su teléfono (compartido por WhatsApp), sin crear ningún usuario. El
// token es la única fuente de verdad: no queda nada guardado en base de
// datos, así que no hay forma de "revocarlo" antes de que expire (48h).
router.post('/generar-link', authenticate, requireRole('Supervisor', 'Gerente'), asyncHandler(async (req, res) => {
  const { sucursalId, fecha } = req.body;
  if (!sucursalId || !fecha) {
    return res.status(400).json({ error: 'sucursalId y fecha son requeridos.' });
  }
  if (!tieneAccesoSucursal(req, sucursalId)) {
    return res.status(403).json({ error: 'No tienes acceso a esta sucursal.' });
  }

  const token = jwt.sign(
    { scope: 'upload_boleta', sucursalId: Number(sucursalId), fecha },
    env.jwt.secret,
    { expiresIn: '48h' }
  );

  res.json({ token });
}));

// GET /api/boletas/publico/motoristas?token=
// Mismo listado que "Subir boleta", pero el sucursalId/fecha vienen del
// token (nunca de query del cliente) y solo se exponen motoristaId +
// nombre. El motorista se identifica buscando y tocando su propio
// nombre en la lista — no hay un paso aparte de código.
router.get('/publico/motoristas', verificarTokenBoleta, asyncHandler(async (req, res) => {
  const { sucursalId, fecha } = req.boletaToken;
  const motoristas = await obtenerMotoristasBoleta({}, fecha, sucursalId);
  res.json(motoristas.map((m) => ({ motoristaId: m.motoristaId, nombre: m.nombre })));
}));

// POST /api/boletas/publico/:motoristaId  (form-data: imagen; body: token)
router.post(
  '/publico/:motoristaId',
  verificarTokenBoleta,
  uploadBoleta.single('imagen'),
  convertirHeicSiCorresponde(),
  asyncHandler(async (req, res) => {
    const motoristaId = Number(req.params.motoristaId);
    const { sucursalId, fecha } = req.boletaToken;

    if (!req.file) {
      return res.status(400).json({ error: 'Debes adjuntar una imagen.' });
    }

    // El motoristaId tiene que estar en la lista de este CAD/fecha —
    // evita usar el link para subir a nombre de cualquier persona_id
    // que exista en el sistema fuera de esta lista.
    const motoristas = await obtenerMotoristasBoleta({}, fecha, sucursalId);
    if (!motoristas.some((m) => Number(m.motoristaId) === motoristaId)) {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'Este motorista no está asignado a este CAD en esta fecha.' });
    }

    const { subidaDrive } = await guardarBoletaMotorista({
      motoristaId, sucursalId, fecha, archivo: req.file, usuarioId: null
    });

    res.json({ ok: true, subidaDrive });
  })
);

export default router;
