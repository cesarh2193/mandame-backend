import fs from 'node:fs';
import { google } from 'googleapis';
import { env } from '../config/env.js';

let driveClient = null;

// Cliente perezoso: si no hay GOOGLE_DRIVE_KEY_FILE/GOOGLE_DRIVE_FOLDER_ID
// configurados, devuelve null y quien llama simplemente omite la subida.
function obtenerDrive() {
  if (!env.googleDrive.keyFile || !env.googleDrive.folderId) return null;
  if (!driveClient) {
    const auth = new google.auth.GoogleAuth({
      keyFile: env.googleDrive.keyFile,
      scopes: ['https://www.googleapis.com/auth/drive']
    });
    driveClient = google.drive({ version: 'v3', auth });
  }
  return driveClient;
}

async function buscarOCrearCarpeta(drive, nombre, carpetaPadreId) {
  const nombreEscapado = nombre.replace(/'/g, "\\'");
  const q = `name = '${nombreEscapado}' and '${carpetaPadreId}' in parents ` +
    `and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;

  const { data } = await drive.files.list({ q, fields: 'files(id, name)', spaces: 'drive' });
  if (data.files?.length) return data.files[0].id;

  const { data: nueva } = await drive.files.create({
    requestBody: { name: nombre, mimeType: 'application/vnd.google-apps.folder', parents: [carpetaPadreId] },
    fields: 'id'
  });
  return nueva.id;
}

/**
 * Sube (o reemplaza, si viene driveFileIdExistente) la imagen de una
 * boleta dentro de <carpeta raíz>/<fecha>/<CAD>/ en Drive. Nunca
 * lanza: si Drive no está configurado o la subida falla por cualquier
 * razón, devuelve null y deja el detalle en el log — el guardado
 * local de la boleta no debe depender de esto.
 */
export async function subirBoletaADrive({ rutaLocal, nombreArchivo, mimeType, fecha, cad, driveFileIdExistente }) {
  const drive = obtenerDrive();
  if (!drive) {
    console.warn('[drive] GOOGLE_DRIVE_KEY_FILE/GOOGLE_DRIVE_FOLDER_ID no configurados: se omite la subida a Drive.');
    return null;
  }

  try {
    const carpetaFecha = await buscarOCrearCarpeta(drive, fecha, env.googleDrive.folderId);
    const carpetaCad = await buscarOCrearCarpeta(drive, cad, carpetaFecha);
    const media = { mimeType, body: fs.createReadStream(rutaLocal) };

    if (driveFileIdExistente) {
      const { data } = await drive.files.update({
        fileId: driveFileIdExistente,
        addParents: carpetaCad,
        requestBody: { name: nombreArchivo },
        media,
        fields: 'id, webViewLink'
      });
      return { driveFileId: data.id, driveWebLink: data.webViewLink };
    }

    const { data } = await drive.files.create({
      requestBody: { name: nombreArchivo, parents: [carpetaCad] },
      media,
      fields: 'id, webViewLink'
    });
    return { driveFileId: data.id, driveWebLink: data.webViewLink };
  } catch (err) {
    console.error('[drive] No se pudo subir la boleta a Google Drive:', err.message);
    return null;
  }
}
