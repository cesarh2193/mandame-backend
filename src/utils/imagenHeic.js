import fs from 'node:fs/promises';
import path from 'node:path';
import convert from 'heic-convert';
import { logger } from './logger.js';

const MIMETYPES_HEIC = ['image/heic', 'image/heif'];
const EXTENSIONES_HEIC = ['.heic', '.heif'];

// Los iPhone guardan fotos en HEIC por defecto, y según el navegador
// móvil el mimetype que llega puede venir correcto (image/heic) o
// genérico (application/octet-stream) — por eso también miramos la
// extensión del nombre original como respaldo.
export function esArchivoHeic(file) {
  if (!file) return false;
  if (MIMETYPES_HEIC.includes(file.mimetype)) return true;
  return esExtensionHeic(file.originalname);
}

// true si el nombre de archivo original termina en .heic/.heif — respaldo
// para cuando el navegador no manda un mimetype útil (application/octet-stream).
export function esExtensionHeic(nombreOriginal) {
  const ext = path.extname(nombreOriginal || '').toLowerCase();
  return EXTENSIONES_HEIC.includes(ext);
}

// Extensión a usar para el archivo temporal cuando el mimetype no viene
// en el mapa de tipos permitidos de un multer config, pero el nombre
// original sí trae una extensión reconocible (ej. HEIC por octet-stream).
export function elegirExtensionPorNombre(nombreOriginal) {
  const ext = path.extname(nombreOriginal || '').toLowerCase();
  return ext || null;
}

/**
 * Middleware de Express para usar justo después de un upload.single(...)
 * de multer: si el archivo que se acaba de guardar en disco es HEIC/HEIF,
 * lo convierte a JPG en el mismo directorio y actualiza req.file (path,
 * filename, mimetype, size) para que el resto del flujo — guardado local,
 * subida a Drive, etc. — siga igual que si el usuario hubiera subido un
 * JPG normal desde el inicio.
 */
export function convertirHeicSiCorresponde() {
  return async (req, res, next) => {
    if (!req.file || !esArchivoHeic(req.file)) return next();

    const rutaOriginal = req.file.path;
    const rutaJpg = rutaOriginal.slice(0, -path.extname(rutaOriginal).length) + '.jpg';

    try {
      const bufferOriginal = await fs.readFile(rutaOriginal);
      const bufferJpg = await convert({ buffer: bufferOriginal, format: 'JPEG', quality: 0.9 });
      await fs.writeFile(rutaJpg, bufferJpg);
      await fs.unlink(rutaOriginal);

      req.file.path = rutaJpg;
      req.file.filename = path.basename(rutaJpg);
      req.file.mimetype = 'image/jpeg';
      req.file.size = bufferJpg.length;
      next();
    } catch (err) {
      logger.error('[heic] No se pudo convertir la imagen HEIC a JPG: ' + err.message, {
        archivo: req.file.originalname, stack: err.stack
      });
      fs.unlink(rutaOriginal).catch(() => {});
      res.status(400).json({ error: 'No se pudo procesar esta foto (formato HEIC dañado o no compatible). Intenta subirla como JPG o PNG.' });
    }
  };
}
