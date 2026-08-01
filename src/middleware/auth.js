import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/**
 * Verifica el JWT del header Authorization: Bearer <token> y deja
 * la info del usuario en req.user = { usuarioId, usuario, nombre, roles }.
 * roles es un array (ej. ['Supervisor', 'Motorista']) — un usuario
 * puede tener más de uno, como ya se definió en el diseño.
 */
export function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'No autenticado. Falta el token.' });
  }

  try {
    const payload = jwt.verify(token, env.jwt.secret);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o vencido.' });
  }
}

/** true si el usuario autenticado tiene el rol Administrador */
export function esAdministrador(req) {
  return req.user?.roles?.includes('Admin');
}

/**
 * Bloquea la ruta si el usuario no tiene ninguno de los roles dados.
 * El Administrador siempre pasa, sin importar qué roles pida la ruta.
 */
export function requireRole(...rolesPermitidos) {
  return (req, res, next) => {
    if (esAdministrador(req)) return next();
    const tieneAlguno = req.user?.roles?.some((r) => rolesPermitidos.includes(r));
    if (!tieneAlguno) {
      return res.status(403).json({ error: 'No tienes permiso para esta acción.' });
    }
    next();
  };
}

/**
 * true si el usuario autenticado puede operar sobre esa sucursal:
 * Administrador siempre puede; el resto solo si la sucursal está
 * en su lista de usuario_sucursal (req.user.sucursalIds).
 */
export function tieneAccesoSucursal(req, sucursalId) {
  if (esAdministrador(req)) return true;
  const id = Number(sucursalId);
  return (req.user?.sucursalIds || []).includes(id);
}

/** Middleware listo para usar cuando la sucursal viene en query/body/params */
export function requireAccesoSucursal(getSucursalId) {
  return (req, res, next) => {
    const sucursalId = getSucursalId(req);
    if (sucursalId && !tieneAccesoSucursal(req, sucursalId)) {
      return res.status(403).json({ error: 'No tienes acceso a esta sucursal.' });
    }
    next();
  };
}
