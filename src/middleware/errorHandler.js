/**
 * Middleware final de errores. Traduce los errores SIGNAL de los
 * procedimientos almacenados (SQLSTATE 45000, el que usan
 * sp_anular_asignacion y tr_asignacion_evita_titular_duplicado)
 * en un mensaje legible en vez de un stacktrace de MySQL.
 */
export function errorHandler(err, req, res, next) {
  console.error(err);

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

  res.status(500).json({ error: 'Error interno del servidor.' });
}

/** Envuelve un handler async para no repetir try/catch en cada ruta */
export function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}
