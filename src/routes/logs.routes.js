import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();

// No usa el middleware `authenticate` a propósito: un error de frontend
// puede pasar en la pantalla de login o con el token ya vencido, y
// justamente esos son casos que también queremos ver. Si viene un token
// válido igual lo identificamos, para saber quién lo vivió.
function intentarIdentificar(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      req.user = jwt.verify(token, env.jwt.secret);
    } catch {
      // token vencido o inválido — seguimos igual, no es motivo para rechazar el log
    }
  }
  next();
}

// POST /api/logs/frontend — el navegador de un usuario manda acá los
// errores que no pudo manejar (JS roto, promesas sin catch, respuestas
// 5xx) para que queden en el mismo log que los del backend, con quién
// estaba y en qué pantalla.
router.post('/frontend', intentarIdentificar, asyncHandler(async (req, res) => {
  const { mensaje, stack, pagina } = req.body || {};
  logger.error(`[frontend] ${String(mensaje || 'Error sin mensaje').slice(0, 500)}`, {
    stack: stack ? String(stack).slice(0, 3000) : null,
    pagina,
    usuario: req.user?.usuario || null,
    usuarioId: req.user?.usuarioId || null
  });
  res.status(204).end();
}));

export default router;
