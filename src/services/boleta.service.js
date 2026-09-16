import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../config/db.js';
import { subirBoletaADrive, renombrarBoletaEnDrive } from '../utils/googleDrive.js';
import { UPLOADS_BOLETAS_DIR } from '../config/uploadsBoleta.js';

/**
 * Guarda/reemplaza la boleta de un motorista para una fecha: la sube al
 * servidor (ya la dejó ahí multer) y a Drive si está configurado, y deja
 * el registro en boleta_motorista. Si ya existía una boleta de ese
 * motorista/fecha, NO se borra: se renombra (local y en Drive) marcándola
 * como reemplazada, y la nueva queda como la boleta activa.
 *
 * usuarioId puede venir null (subida desde el link público, que no está
 * ligado a ninguna cuenta) — la columna se ajustó a NULL-able para esto,
 * ver scripts/permitir-boleta-sin-usuario.js.
 *
 * Usado tanto por la subida autenticada (boletaImagen.routes.js) como
 * por la subida vía link público (boletasPublicas.routes.js), para no
 * duplicar esta lógica en los dos lados.
 */
export async function guardarBoletaMotorista({ motoristaId, sucursalId, fecha, archivo, usuarioId }) {
  const [[persona]] = await pool.query(
    `SELECT CONCAT(p.nombres,' ',p.apellidos) AS nombre
     FROM motorista m JOIN persona p ON p.persona_id = m.persona_id
     WHERE m.persona_id = ?`,
    [motoristaId]
  );
  const [[sucursal]] = await pool.query(
    'SELECT nombre, codigo_cad AS codigoCad FROM sucursal WHERE sucursal_id = ?',
    [Number(sucursalId)]
  );

  const [[existente]] = await pool.query(
    'SELECT * FROM boleta_motorista WHERE motorista_id = ? AND fecha = ?',
    [motoristaId, fecha]
  );

  if (existente) {
    const marca = `reemplazada ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;

    const extAnterior = path.extname(existente.archivo_local);
    const nombreLocalNuevo = `${existente.archivo_local.slice(0, -extAnterior.length)}-${marca.replace(/[: ]/g, '-')}${extAnterior}`;
    fs.rename(
      path.join(UPLOADS_BOLETAS_DIR, existente.archivo_local),
      path.join(UPLOADS_BOLETAS_DIR, nombreLocalNuevo),
      () => {}
    );

    if (existente.drive_file_id) {
      const nombreDriveAnterior = `${persona?.nombre || 'Motorista'} - ${fecha} (${marca})${extAnterior}`;
      await renombrarBoletaEnDrive(existente.drive_file_id, nombreDriveAnterior);
    }
  }

  const ext = path.extname(archivo.filename);
  const nombreDrive = `${persona?.nombre || 'Motorista'} - ${fecha}${ext}`;

  const resultadoDrive = await subirBoletaADrive({
    rutaLocal: archivo.path,
    nombreArchivo: nombreDrive,
    mimeType: archivo.mimetype,
    fecha,
    cad: sucursal?.nombre || 'CAD',
    cadCodigo: sucursal?.codigoCad || ''
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
        archivo.filename,
        resultadoDrive?.driveFileId ?? null,
        resultadoDrive?.driveWebLink ?? null,
        usuarioId,
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
        motoristaId, Number(sucursalId), fecha, archivo.filename,
        resultadoDrive?.driveFileId ?? null, resultadoDrive?.driveWebLink ?? null, usuarioId
      ]
    );
  }

  return { subidaDrive: !!resultadoDrive };
}
