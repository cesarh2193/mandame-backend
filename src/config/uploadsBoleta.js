import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';

// Carpeta y configuración de multer compartidas entre la subida
// autenticada (boletaImagen.routes.js) y la subida por link público
// (boletasPublicas.routes.js) — mismo destino, mismas reglas de tamaño
// y formato para las dos vías.
export const UPLOADS_BOLETAS_DIR = path.resolve(process.cwd(), 'uploads', 'boletas');
fs.mkdirSync(UPLOADS_BOLETAS_DIR, { recursive: true });

const EXTENSIONES_BOLETA = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

export const uploadBoleta = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_BOLETAS_DIR),
    filename: (req, file, cb) => {
      const ext = EXTENSIONES_BOLETA[file.mimetype] || path.extname(file.originalname) || '.jpg';
      const motoristaId = req.params.motoristaId;
      const fecha = req.boletaToken?.fecha || req.query.fecha;
      cb(null, `${motoristaId}-${fecha}-${Date.now()}${ext}`);
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
