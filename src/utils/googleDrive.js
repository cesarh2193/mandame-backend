import fs from 'node:fs';
import { google } from 'googleapis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

let driveClient = null;

// Cliente perezoso: si falta cualquiera de las variables de OAuth2 o
// el folderId, devuelve null y quien llama simplemente omite la
// subida. OAuth2 con refresh token (no cuenta de servicio): una
// cuenta de servicio sin Workspace no tiene cuota de almacenamiento
// propia y no puede subir archivos ("Service Accounts do not have
// storage quota") — con OAuth2 el archivo se sube a nombre del
// usuario dueño del refresh token, que sí tiene cuota.
function obtenerDrive() {
  const { folderId, oauthClientId, oauthClientSecret, oauthRefreshToken } = env.googleDrive;
  if (!folderId || !oauthClientId || !oauthClientSecret || !oauthRefreshToken) return null;

  if (!driveClient) {
    const auth = new google.auth.OAuth2(oauthClientId, oauthClientSecret);
    auth.setCredentials({ refresh_token: oauthRefreshToken });
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
 * Sube la imagen de una boleta dentro de <carpeta raíz>/<fecha>/<CAD>/
 * en Drive, siempre como archivo nuevo (no reemplaza contenido de un
 * archivo existente — para eso primero se renombra el anterior con
 * renombrarBoletaEnDrive, así queda de bitácora). Nunca lanza: si
 * Drive no está configurado o la subida falla por cualquier razón,
 * devuelve null y deja el detalle en el log — el guardado local de
 * la boleta no debe depender de esto.
 */
export async function subirBoletaADrive({ rutaLocal, nombreArchivo, mimeType, fecha, cad }) {
  const drive = obtenerDrive();
  if (!drive) {
    logger.warn('[drive] Faltan variables de OAuth2 (GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN) o GOOGLE_DRIVE_FOLDER_ID: se omite la subida a Drive.', { nombreArchivo, fecha, cad });
    return null;
  }

  try {
    const carpetaFecha = await buscarOCrearCarpeta(drive, fecha, env.googleDrive.folderId);
    const carpetaCad = await buscarOCrearCarpeta(drive, cad, carpetaFecha);

    const { data } = await drive.files.create({
      requestBody: { name: nombreArchivo, parents: [carpetaCad] },
      media: { mimeType, body: fs.createReadStream(rutaLocal) },
      fields: 'id, webViewLink'
    });
    return { driveFileId: data.id, driveWebLink: data.webViewLink };
  } catch (err) {
    logger.error('[drive] No se pudo subir la boleta a Google Drive: ' + err.message, { nombreArchivo, fecha, cad, stack: err.stack });
    return null;
  }
}

/**
 * Renombra (sin tocar el contenido) una boleta ya subida a Drive —
 * se usa para dejarla marcada como "reemplazada" antes de subir la
 * nueva, en vez de perderla. Nunca lanza, solo loguea si falla.
 */
export async function renombrarBoletaEnDrive(driveFileId, nuevoNombre) {
  const drive = obtenerDrive();
  if (!drive || !driveFileId) return false;

  try {
    await drive.files.update({ fileId: driveFileId, requestBody: { name: nuevoNombre } });
    return true;
  } catch (err) {
    logger.error('[drive] No se pudo renombrar la boleta anterior en Drive: ' + err.message, { driveFileId, nuevoNombre, stack: err.stack });
    return false;
  }
}
