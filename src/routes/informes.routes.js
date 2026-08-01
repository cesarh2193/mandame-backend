import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';
import { pool } from '../config/db.js';
import { authenticate, esAdministrador, tieneAccesoSucursal } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(authenticate);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.join(__dirname, '../assets/logo-mandame.png');

async function obtenerFilasBoleta(req, fecha, sucursalId) {
  const condiciones = ['r.fecha = ?'];
  const params = [fecha];

  if (sucursalId) {
    condiciones.push('a.sucursal_id = ?');
    params.push(Number(sucursalId));
  } else if (!esAdministrador(req)) {
    condiciones.push('a.sucursal_id IN (?)');
    params.push(req.user.sucursalIds?.length ? req.user.sucursalIds : [0]);
  }

  const [rows] = await pool.query(
    `SELECT p.codigo_interno AS codigo, CONCAT(p.nombres,' ',p.apellidos) AS nombre,
            m.placa, s.nombre AS sucursal, r.fecha, r.cantidad_entregas AS cantidadRepartos,
            r.observacion,
            TIME_FORMAT(ing.fecha_hora, '%H:%i') AS horaIngreso,
            TIME_FORMAT(sal.fecha_hora, '%H:%i') AS horaSalida,
            TIMESTAMPDIFF(MINUTE, ing.fecha_hora, sal.fecha_hora) AS minutosTrabajados
     FROM reparto r
     JOIN asignacion a ON a.asignacion_id = r.asignacion_id
     JOIN motorista m ON m.persona_id = a.motorista_id
     JOIN persona p ON p.persona_id = m.persona_id
     JOIN sucursal s ON s.sucursal_id = a.sucursal_id
     LEFT JOIN asistencia_marca ing ON ing.asignacion_id = a.asignacion_id
       AND ing.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'INGRESO')
       AND DATE(ing.fecha_hora) = r.fecha
     LEFT JOIN asistencia_marca sal ON sal.asignacion_id = a.asignacion_id
       AND sal.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'SALIDA')
       AND DATE(sal.fecha_hora) = r.fecha
     WHERE ${condiciones.join(' AND ')}
     ORDER BY s.nombre, p.nombres`,
    params
  );
  return rows;
}

function formatearFecha(fecha) {
  const [anio, mes, dia] = String(fecha).slice(0, 10).split('-');
  return `${dia}/${mes}/${anio}`;
}

// Dibuja una boleta dentro de la mitad superior o inferior de la hoja
// (posicion 0 = arriba, 1 = abajo) — así salen 2 motoristas por hoja.
function dibujarBoleta(doc, fila, posicion) {
  const anchoPagina = doc.page.width;
  const altoMitad = doc.page.height / 2;
  const y0 = posicion * altoMitad;
  const margenX = 40;
  const anchoUtil = anchoPagina - margenX * 2;
  const margenSuperior = 18;
  const altoBoleta = altoMitad - margenSuperior - 10;

  doc.rect(margenX, y0 + margenSuperior, anchoUtil, altoBoleta).stroke();

  // Encabezado: título + logo
  doc.rect(margenX + 12, y0 + margenSuperior + 12, 230, 34).fillAndStroke('#EAEAEA', '#000000');
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(12)
    .text('REPORTE DIARIO DE PERSONAL', margenX + 20, y0 + margenSuperior + 24, { width: 215 });

  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, margenX + anchoUtil - 90, y0 + margenSuperior + 8, { width: 65 });
  }

  // FECHA, arriba a la derecha
  const xFecha = margenX + anchoUtil - 210;
  const yFecha = y0 + margenSuperior + 55;
  doc.font('Helvetica-Bold').fontSize(9).text('FECHA', xFecha, yFecha);
  doc.font('Helvetica').fontSize(9).text(formatearFecha(fila.fecha), xFecha + 45, yFecha);
  doc.moveTo(xFecha + 42, yFecha + 11).lineTo(xFecha + 145, yFecha + 11).stroke();

  // Columna izquierda: campos con línea para llenar
  let y = y0 + margenSuperior + 60;
  const xLabel = margenX + 20;
  const xValor = margenX + 110;
  const xLineaFin = margenX + 285;

  function campo(label, valor) {
    doc.font('Helvetica-Bold').fontSize(9).text(label, xLabel, y);
    doc.font('Helvetica').fontSize(9).text(valor != null && valor !== '' ? String(valor) : '', xValor, y);
    doc.moveTo(xValor - 5, y + 11).lineTo(xLineaFin, y + 11).stroke();
    y += 15;
  }

  campo('NOMBRE', fila.nombre);
  campo('CODIGO', fila.codigo);
  campo('PLACA', fila.placa);
  campo('CAD', fila.sucursal);
  y += 5;
  campo('Cantidad Repartos', fila.cantidadRepartos);
  campo('Horas Trabajadas', fila.minutosTrabajados != null ? (fila.minutosTrabajados / 60).toFixed(1) : '');
  campo('Hora Ingreso', fila.horaIngreso);
  campo('Hora Salida', fila.horaSalida);
  campo('Hora Extra', '');

  // Columna derecha: casillas de tipo de consumo y de turno, en
  // blanco — se marcan a mano al momento de usar la boleta.
  const xCasillaLabel = margenX + anchoUtil - 200;
  const xCasilla = margenX + anchoUtil - 40;
  let yCasilla = y0 + margenSuperior + 85;
  ['Desayuno', 'Almuerzo', 'Cena'].forEach((label) => {
    doc.font('Helvetica').fontSize(9).text(label, xCasillaLabel, yCasilla);
    doc.rect(xCasilla, yCasilla - 2, 11, 11).stroke();
    yCasilla += 17;
  });

  yCasilla += 6;
  doc.font('Helvetica-Bold').fontSize(9).text('TURNO', xCasillaLabel, yCasilla);
  yCasilla += 15;
  ['Mixto', 'Corrido'].forEach((label) => {
    doc.font('Helvetica').fontSize(9).text(label, xCasillaLabel, yCasilla);
    doc.rect(xCasilla, yCasilla - 2, 11, 11).stroke();
    yCasilla += 17;
  });

  // Observaciones
  y += 8;
  doc.font('Helvetica-Bold').fontSize(9).text('Observaciones', xLabel, y);
  doc.font('Helvetica').fontSize(9).text(fila.observacion || '', xValor, y, { width: anchoUtil - 150 });
  doc.moveTo(xValor - 5, y + 11).lineTo(margenX + anchoUtil - 15, y + 11).stroke();

  // Firma + sello, al pie de la boleta
  const yPie = y0 + margenSuperior + altoBoleta - 40;
  doc.moveTo(xLabel, yPie).lineTo(xLabel + 210, yPie).stroke();
  doc.font('Helvetica').fontSize(9).text('Nombre, codigo, firma.', xLabel, yPie + 4);

  const anchoSello = 165;
  const xSello = margenX + anchoUtil - anchoSello - 15;
  doc.rect(xSello, yPie - 45, anchoSello, 55).stroke();
  doc.font('Helvetica').fontSize(9).text('Sello de Restaurante', xSello, yPie + 12, { width: anchoSello, align: 'center' });
}

// GET /api/informes/boleta?fecha=&sucursalId=
// Genera un PDF con la boleta de cada motorista que tuvo asistencia
// y cierre de turno en esa fecha (solo aparecen los que ya cerraron
// turno — sin cierre no hay "reparto", y sin reparto no hay boleta),
// dos por hoja. Sin sucursalId trae todas las CAD a las que el
// usuario tiene acceso.
router.get('/boleta', asyncHandler(async (req, res) => {
  const { fecha, sucursalId } = req.query;
  if (!fecha) {
    return res.status(400).json({ error: 'La fecha es requerida.' });
  }
  if (sucursalId && !tieneAccesoSucursal(req, sucursalId)) {
    return res.status(403).json({ error: 'No tienes acceso a esta sucursal.' });
  }

  const filas = await obtenerFilasBoleta(req, fecha, sucursalId);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="boletas-${fecha}.pdf"`);

  const doc = new PDFDocument({ margin: 0, size: 'LETTER' });
  doc.pipe(res);

  if (filas.length === 0) {
    doc.font('Helvetica').fontSize(13).text(
      'No hay motoristas con asistencia y cierre de turno registrado para esta fecha.',
      40, 40, { width: doc.page.width - 80 }
    );
  } else {
    filas.forEach((fila, i) => {
      const posicion = i % 2;
      if (i > 0 && posicion === 0) doc.addPage();
      dibujarBoleta(doc, fila, posicion);
    });
  }

  doc.end();
}));

export default router;
