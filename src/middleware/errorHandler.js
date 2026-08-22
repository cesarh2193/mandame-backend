import { logger } from '../utils/logger.js';

// Errores de MySQL que se pueden traducir a un mensaje entendible sin
// exponer nombres de tabla/columna al usuario final. `logger.error(...)`
// más abajo ya deja el detalle completo (incluye err.sqlMessage y el
// stack) en /logs para quien necesite ver la causa exacta, aunque nadie
// esté mirando la terminal en ese momento.
const MENSAJES_MYSQL = {
  ER_NO_REFERENCED_ROW_2: 'No se pudo guardar: uno de los datos relacionados (CAD, rol o persona) no existe o fue eliminado.',
  ER_NO_REFERENCED_ROW: 'No se pudo guardar: uno de los datos relacionados no existe o fue eliminado.',
  ER_BAD_NULL_ERROR: 'Falta completar un dato requerido.',
  ER_DATA_TOO_LONG: 'Uno de los campos tiene más texto del permitido.',
  ER_ROW_IS_REFERENCED_2: 'No se puede eliminar: hay otros registros que dependen de este.',
  ER_ROW_IS_REFERENCED: 'No se puede eliminar: hay otros registros que dependen de este.'
};

/**
 * Middleware final de errores. Traduce los errores SIGNAL de los
 * procedimientos almacenados (SQLSTATE 45000, el que usan
 * sp_anular_asignacion y tr_asignacion_evita_titular_duplicado)
 * en un mensaje legible en vez de un stacktrace de MySQL.
 */
export function errorHandler(err, req, res, next) {
  logger.error(err?.message || 'Error sin mensaje', {
    stack: err?.stack,
    sqlMessage: err?.sqlMessage,
    metodo: req.method,
    ruta: req.originalUrl,
    usuarioId: req.user?.usuarioId
  });

  if (err?.sqlState === '45000') {
    return res.status(409).json({ error: err.sqlMessage || 'La operación no cumple una regla de negocio.' });
  }

  if (err?.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ error: 'Ya existe un registro con ese dato único.' });
  }

  if (err?.name === 'MulterError') {
    const mensaje = err.code === 'LIMIT_FILE_SIZE' ? 'El archivo no puede pesar más de 8 MB.' : err.message;
    return res.status(400).json({ error: mensaje });
  }

  if (err?.message?.includes('Formato no soportado') || err?.message?.includes('Formato de imagen no soportado')) {
    return res.status(400).json({ error: err.message });
  }

  if (err?.code && MENSAJES_MYSQL[err.code]) {
    return res.status(400).json({ error: MENSAJES_MYSQL[err.code] });
  }

  res.status(500).json({ error: 'Error interno del servidor.' });
}

/** Envuelve un handler async para no repetir try/catch en cada ruta */
export function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}
