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

const MESES_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
];

// Nombre de carpeta pedido por gerencia para la segunda copia en Drive,
// ej. "Semana40 lunes 14 al domingo 20 de septiembre 2026". Semana ISO
// (lunes a domingo), igual criterio que calcularSemanaISO en informes.routes.js.
function calcularCarpetaSemana(fechaStr) {
  const fecha = new Date(`${fechaStr}T00:00:00`);
  const diaSemana = (fecha.getDay() + 6) % 7; // 0=lunes..6=domingo
  const lunes = new Date(fecha);
  lunes.setDate(fecha.getDate() - diaSemana);
  const domingo = new Date(lunes);
  domingo.setDate(lunes.getDate() + 6);

  const objetivo = new Date(lunes);
  objetivo.setDate(objetivo.getDate() + 3); // jueves de esa semana (define el año/semana ISO)
  const primerJueves = new Date(objetivo.getFullYear(), 0, 4);
  const diff = objetivo - primerJueves;
  const semana = 1 + Math.round(diff / (7 * 24 * 60 * 60 * 1000));

  const rango = lunes.getMonth() === domingo.getMonth()
    ? `lunes ${lunes.getDate()} al domingo ${domingo.getDate()} de ${MESES_ES[lunes.getMonth()]}`
    : `lunes ${lunes.getDate()} de ${MESES_ES[lunes.getMonth()]} al domingo ${domingo.getDate()} de ${MESES_ES[domingo.getMonth()]}`;

  return `Semana${semana} ${rango} ${domingo.getFullYear()}`;
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
export async function subirBoletaADrive({ rutaLocal, nombreArchivo, mimeType, fecha, cad, cadCodigo }) {
  const drive = obtenerDrive();
  if (!drive) {
    logger.warn('[drive] Faltan variables de OAuth2 (GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN) o GOOGLE_DRIVE_FOLDER_ID: se omite la subida a Drive.', { nombreArchivo, fecha, cad });
    return null;
  }

  let resultado = null;
  try {
    // Estructura histórica: carga_semanal1/<fecha>/<CAD>/archivo
    const carpetaFecha = await buscarOCrearCarpeta(drive, fecha, env.googleDrive.folderId);
    const carpetaCad = await buscarOCrearCarpeta(drive, cad, carpetaFecha);

    const { data } = await drive.files.create({
      requestBody: { name: nombreArchivo, parents: [carpetaCad] },
      media: { mimeType, body: fs.createReadStream(rutaLocal) },
      fields: 'id, webViewLink'
    });
    resultado = { driveFileId: data.id, driveWebLink: data.webViewLink };
  } catch (err) {
    logger.error('[drive] No se pudo subir la boleta a Google Drive: ' + err.message, { nombreArchivo, fecha, cad, stack: err.stack });
    return null;
  }

  // Segunda copia pedida por gerencia, en la misma cuenta de Drive, bajo
  // MandameAPP/<Semana N ...>/<CODIGO-CAD>/archivo. "MandameAPP" se crea
  // directo en la raíz de "Mi unidad" (alias 'root' de la API) — no
  // requiere ningún ID de carpeta configurado a mano. Si esta segunda
  // subida falla, no debe afectar el resultado de la copia histórica
  // (que ya se guardó bien), solo se deja registrado en el log.
  try {
    const carpetaRaizApp = await buscarOCrearCarpeta(drive, 'MandameAPP', 'root');
    const carpetaSemana = await buscarOCrearCarpeta(drive, calcularCarpetaSemana(fecha), carpetaRaizApp);
    const nombreCadConCodigo = cadCodigo ? `${cadCodigo}-${cad}` : cad;
    const carpetaCadSemanal = await buscarOCrearCarpeta(drive, nombreCadConCodigo, carpetaSemana);

    await drive.files.create({
      requestBody: { name: nombreArchivo, parents: [carpetaCadSemanal] },
      media: { mimeType, body: fs.createReadStream(rutaLocal) },
      fields: 'id'
    });
  } catch (err) {
    logger.error('[drive] No se pudo subir la copia semanal (MandameAPP) de la boleta: ' + err.message, { nombreArchivo, fecha, cad, stack: err.stack });
  }

  return resultado;
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
