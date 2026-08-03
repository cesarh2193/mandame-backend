import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { pool } from '../config/db.js';
import { authenticate, esAdministrador, tieneAccesoSucursal } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { UPLOADS_DIR } from './personal.routes.js';

const LOGO_MANDAME_PATH = path.resolve(process.cwd(), '../mandame-frontend/src/assets/logo-mandame.png');

const router = Router();
router.use(authenticate);

function normalizarMotoristaIds(motoristaIds) {
  if (!motoristaIds) return [];
  if (Array.isArray(motoristaIds)) {
    return motoristaIds.map((id) => Number(id)).filter((id) => !Number.isNaN(id));
  }

  return String(motoristaIds)
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((id) => !Number.isNaN(id));
}

function construirCondicionesBoleta(req, fecha, sucursalId, motoristaIds) {
  const condiciones = ['r.fecha = ?', "r.estado = 'AUTORIZADO'"];
  const params = [fecha];

  if (sucursalId) {
    condiciones.push('a.sucursal_id = ?');
    params.push(Number(sucursalId));
  } else if (!esAdministrador(req)) {
    condiciones.push('a.sucursal_id IN (?)');
    params.push(req.user.sucursalIds?.length ? req.user.sucursalIds : [0]);
  }

  const ids = normalizarMotoristaIds(motoristaIds);
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(', ');
    condiciones.push(`a.motorista_id IN (${placeholders})`);
    params.push(...ids);
  }

  return { condiciones, params };
}

async function obtenerFilasBoleta(req, fecha, sucursalId, motoristaIds) {
  const { condiciones, params } = construirCondicionesBoleta(req, fecha, sucursalId, motoristaIds);

  const [rows] = await pool.query(
    `SELECT p.codigo_interno AS codigo, CONCAT(p.nombres,' ',p.apellidos) AS nombre,
            m.placa, s.nombre AS sucursal, r.fecha, r.cantidad_entregas AS cantidadRepartos,
            r.observacion, t.descripcion AS tarifa,
            TIME_FORMAT(ing.fecha_hora, '%H:%i') AS horaIngreso,
            TIME_FORMAT(sal.fecha_hora, '%H:%i') AS horaSalida,
            TIMESTAMPDIFF(MINUTE, ing.fecha_hora, sal.fecha_hora) AS minutosTrabajados
     FROM reparto r
     JOIN asignacion a ON a.asignacion_id = r.asignacion_id
     JOIN motorista m ON m.persona_id = a.motorista_id
     JOIN persona p ON p.persona_id = m.persona_id
     JOIN sucursal s ON s.sucursal_id = a.sucursal_id
     LEFT JOIN tarifa t ON t.tarifa_id = r.tarifa_id
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

async function obtenerMotoristasBoleta(req, fecha, sucursalId) {
  const condiciones = ['r.fecha = ?', "r.estado = 'AUTORIZADO'"];
  const params = [fecha];

  if (sucursalId) {
    condiciones.push('a.sucursal_id = ?');
    params.push(Number(sucursalId));
  } else if (!esAdministrador(req)) {
    condiciones.push('a.sucursal_id IN (?)');
    params.push(req.user.sucursalIds?.length ? req.user.sucursalIds : [0]);
  }

  const [rows] = await pool.query(
    `SELECT a.motorista_id AS motoristaId,
            p.codigo_interno AS codigo,
            CONCAT(p.nombres,' ',p.apellidos) AS nombre,
            COUNT(*) AS repartos,
            MIN(TIME_FORMAT(ing.fecha_hora, '%H:%i')) AS horaInicio,
            MAX(TIME_FORMAT(sal.fecha_hora, '%H:%i')) AS horaFinal,
            TIMESTAMPDIFF(MINUTE, MIN(ing.fecha_hora), MAX(sal.fecha_hora)) AS minutosTrabajados
     FROM reparto r
     JOIN asignacion a ON a.asignacion_id = r.asignacion_id
     JOIN motorista m ON m.persona_id = a.motorista_id
     JOIN persona p ON p.persona_id = m.persona_id
     LEFT JOIN asistencia_marca ing ON ing.asignacion_id = a.asignacion_id
       AND ing.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'INGRESO')
       AND DATE(ing.fecha_hora) = r.fecha
     LEFT JOIN asistencia_marca sal ON sal.asignacion_id = a.asignacion_id
       AND sal.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'SALIDA')
       AND DATE(sal.fecha_hora) = r.fecha
     WHERE ${condiciones.join(' AND ')}
     GROUP BY a.motorista_id, p.codigo_interno, p.nombres, p.apellidos
     ORDER BY p.nombres`,
    params
  );
  return rows;
}

async function obtenerMotoristasAsistencia(req, sucursalId) {
  const condiciones = ["p.estado = 'A'"];
  const params = [];

  if (sucursalId) {
    condiciones.push('p.sucursal_base_id = ?');
    params.push(Number(sucursalId));
  } else if (!esAdministrador(req)) {
    condiciones.push('p.sucursal_base_id IN (?)');
    params.push(req.user.sucursalIds?.length ? req.user.sucursalIds : [0]);
  }

  const [rows] = await pool.query(
    `SELECT m.persona_id AS motoristaId,
            CONCAT(p.nombres,' ',p.apellidos) AS nombre,
            p.codigo_interno AS codigo
     FROM motorista m
     JOIN persona p ON p.persona_id = m.persona_id
     WHERE ${condiciones.join(' AND ')}
     ORDER BY p.nombres, p.apellidos`,
    params
  );
  return rows;
}

const DIAS_ES = {
  Monday: 'Lunes',
  Tuesday: 'Martes',
  Wednesday: 'Miércoles',
  Thursday: 'Jueves',
  Friday: 'Viernes',
  Saturday: 'Sábado',
  Sunday: 'Domingo'
};

async function obtenerAsistenciaReporte(req, motoristaId, fechaInicio, fechaFin) {
  const [rows] = await pool.query(
    `SELECT e.fecha AS fecha,
            DAYNAME(e.fecha) AS dia,
            TIME_FORMAT(e.horaEntrada, '%H:%i') AS horaEntrada,
            TIME_FORMAT(s.horaSalida, '%H:%i') AS horaSalida,
            TIMESTAMPDIFF(HOUR, e.horaEntrada, s.horaSalida) AS totalHoras,
            (SELECT COUNT(*) FROM reparto r WHERE r.asignacion_id = a.asignacion_id AND r.fecha = e.fecha) AS repartos,
            CONCAT(pu.nombres, ' ', pu.apellidos) AS controlador
     FROM asignacion a
     JOIN (
       SELECT asignacion_id, DATE(fecha_hora) AS fecha, MIN(fecha_hora) AS horaEntrada
       FROM asistencia_marca
       WHERE tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'INGRESO')
       GROUP BY asignacion_id, DATE(fecha_hora)
     ) e ON e.asignacion_id = a.asignacion_id
     LEFT JOIN (
       SELECT asignacion_id, DATE(fecha_hora) AS fecha, MAX(fecha_hora) AS horaSalida
       FROM asistencia_marca
       WHERE tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'SALIDA')
       GROUP BY asignacion_id, DATE(fecha_hora)
     ) s ON s.asignacion_id = e.asignacion_id AND s.fecha = e.fecha
     LEFT JOIN asistencia_marca sm ON sm.asignacion_id = s.asignacion_id AND sm.fecha_hora = s.horaSalida
     LEFT JOIN usuario u ON u.usuario_id = sm.usuario_registro_id
     LEFT JOIN persona pu ON pu.persona_id = u.persona_id
     WHERE a.motorista_id = ?
       AND e.fecha BETWEEN ? AND ?
     ORDER BY e.fecha`,
    [motoristaId, fechaInicio, fechaFin]
  );
  return rows.map((fila) => ({ ...fila, dia: DIAS_ES[fila.dia] || fila.dia, controlador: fila.controlador || null }));
}

const MESES_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

function calcularSemanaISO(fechaStr) {
  const fecha = new Date(`${fechaStr}T00:00:00`);
  const objetivo = new Date(fecha.valueOf());
  const diaSemana = (fecha.getDay() + 6) % 7;
  objetivo.setDate(objetivo.getDate() - diaSemana + 3);
  const primerJueves = new Date(objetivo.getFullYear(), 0, 4);
  const diff = objetivo - primerJueves;
  return 1 + Math.round(diff / (7 * 24 * 60 * 60 * 1000));
}

function dibujarReporteAsistenciaPDF(doc, datos, info, fechaInicio, fechaFin) {
  const ancho = doc.page.width - 80;
  const x = 40;
  const y0 = 40;

  // Encabezado: caja gris con título + logo, igual estilo que la boleta.
  doc.rect(x, y0, 260, 40).fillAndStroke('#EAEAEA', '#000000');
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(13)
    .text('REPORTE DE ASISTENCIA', x + 10, y0 + 14, { width: 240 });
  doc.image(LOGO_MANDAME_PATH, x + ancho - 150, y0 - 4, { width: 120 });

  const [anio, mes] = fechaInicio.split('-');
  const filasInfo = [
    ['NOMBRE', info.nombre || ''],
    ['DPI', info.dpi || ''],
    ['SEMANA', String(calcularSemanaISO(fechaInicio))],
    ['MES', MESES_ES[Number(mes) - 1] || ''],
    ['CAD', info.cad || '']
  ];

  let yInfo = y0 + 60;
  const xLabel = x;
  const anchoLabel = 120;
  const anchoValor = 430;
  const altoFila = 22;

  filasInfo.forEach(([label, valor]) => {
    doc.rect(xLabel, yInfo, anchoLabel, altoFila).stroke();
    doc.rect(xLabel + anchoLabel, yInfo, anchoValor, altoFila).stroke();
    doc.font('Helvetica-Bold').fontSize(9).text(label, xLabel + 6, yInfo + 6);
    doc.font('Helvetica').fontSize(9).text(String(valor), xLabel + anchoLabel + 6, yInfo + 6, { width: anchoValor - 12 });
    yInfo += altoFila;
  });

  const encabezado = [
    'FECHA', 'DIA', 'HORA ENTRADA', 'HORA SALIDA', 'TOTAL HORAS', 'REPARTOS', 'CONTROLADOR'
  ];

  const inicioY = yInfo + 20;
  let y = inicioY;

  encabezado.forEach((titulo, idx) => {
    const widths = [75, 60, 85, 85, 80, 70, 95];
    const cellX = x + encabezado.slice(0, idx).reduce((acc, _, i) => acc + widths[i], 0);
    doc.rect(cellX, y, widths[idx], 24).stroke();
    doc.font('Helvetica-Bold').fontSize(8).text(titulo, cellX + 4, y + 6, { width: widths[idx] - 8, align: 'center' });
  });

  y += 24;

  datos.forEach((fila) => {
    const row = [
      fila.fecha ? formatearFecha(fila.fecha) : '',
      fila.dia || '',
      fila.horaEntrada || '',
      fila.horaSalida || '',
      fila.totalHoras != null ? String(fila.totalHoras) : '',
      fila.repartos != null ? String(fila.repartos) : '',
      fila.controlador || ''
    ];

    const widths = [75, 60, 85, 85, 80, 70, 95];
    row.forEach((value, idx) => {
      const cellX = x + row.slice(0, idx).reduce((acc, _, i) => acc + widths[i], 0);
      doc.rect(cellX, y, widths[idx], 24).stroke();
      doc.font('Helvetica').fontSize(8).text(String(value), cellX + 4, y + 6, { width: widths[idx] - 8 });
    });
    y += 24;
  });
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

  // Encabezado: título
  doc.rect(margenX + 12, y0 + margenSuperior + 12, 230, 34).fillAndStroke('#EAEAEA', '#000000');
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(12)
    .text('REPORTE DIARIO DE PERSONAL', margenX + 20, y0 + margenSuperior + 24, { width: 215 });

  try {
    doc.image(LOGO_MANDAME_PATH, margenX + anchoUtil - 110, y0 + margenSuperior + 8, { width: 88 });
  } catch {
    // Si el logo no está disponible en el entorno de ejecución, se ignora para no romper la impresión.
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

// GET /api/informes/asistencia/motoristas?sucursalId=
router.get('/asistencia/motoristas', asyncHandler(async (req, res) => {
  const { sucursalId } = req.query;
  if (sucursalId && !tieneAccesoSucursal(req, sucursalId)) {
    return res.status(403).json({ error: 'No tienes acceso a esta sucursal.' });
  }

  const motoristas = await obtenerMotoristasAsistencia(req, sucursalId);
  res.json(motoristas);
}));

// GET /api/informes/asistencia/preview?motoristaId=&fechaInicio=&fechaFin=
router.get('/asistencia/preview', asyncHandler(async (req, res) => {
  const { motoristaId, fechaInicio, fechaFin } = req.query;
  if (!motoristaId || !fechaInicio || !fechaFin) {
    return res.status(400).json({ error: 'Debes seleccionar un motorista y el rango de fechas.' });
  }

  const filas = await obtenerAsistenciaReporte(req, motoristaId, fechaInicio, fechaFin);
  res.json(filas);
}));

// GET /api/informes/asistencia?motoristaId=&fechaInicio=&fechaFin=
router.get('/asistencia', asyncHandler(async (req, res) => {
  const { motoristaId, fechaInicio, fechaFin } = req.query;
  if (!motoristaId || !fechaInicio || !fechaFin) {
    return res.status(400).json({ error: 'Debes seleccionar un motorista y el rango de fechas.' });
  }

  const [infoMotorista] = await pool.query(
    `SELECT CONCAT(p.nombres,' ',p.apellidos) AS nombre, p.dpi AS dpi, s.codigo_cad AS cad
     FROM motorista m
     JOIN persona p ON p.persona_id = m.persona_id
     LEFT JOIN sucursal s ON s.sucursal_id = p.sucursal_base_id
     WHERE m.persona_id = ?`,
    [motoristaId]
  );

  const filas = await obtenerAsistenciaReporte(req, motoristaId, fechaInicio, fechaFin);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="informe-asistencia-${fechaInicio}-${fechaFin}.pdf"`);

  const doc = new PDFDocument({ margin: 0, size: 'LETTER' });
  doc.pipe(res);

  const info = infoMotorista[0] || {};
  if (filas.length === 0) {
    doc.font('Helvetica').fontSize(13).text('No hay datos de asistencia para el rango solicitado.', 40, 40, { width: doc.page.width - 80 });
  } else {
    dibujarReporteAsistenciaPDF(doc, filas, info, fechaInicio, fechaFin);
  }

  doc.end();
}));

// GET /api/informes/boleta/motoristas?fecha=&sucursalId=
router.get('/boleta/motoristas', asyncHandler(async (req, res) => {
  const { fecha, sucursalId } = req.query;
  if (!fecha) {
    return res.status(400).json({ error: 'La fecha es requerida.' });
  }
  if (sucursalId && !tieneAccesoSucursal(req, sucursalId)) {
    return res.status(403).json({ error: 'No tienes acceso a esta sucursal.' });
  }

  const motoristas = await obtenerMotoristasBoleta(req, fecha, sucursalId);
  res.json(motoristas);
}));

// GET /api/informes/boleta?fecha=&sucursalId=&motoristaIds=1,2,3
// Genera un PDF con la boleta de cada motorista que tuvo asistencia
// y cierre de turno en esa fecha (solo aparecen los que ya cerraron
// turno — sin cierre no hay "reparto", y sin reparto no hay boleta),
// dos por hoja. Sin sucursalId trae todas las CAD a las que el
// usuario tiene acceso.
router.get('/boleta', asyncHandler(async (req, res) => {
  const { fecha, sucursalId, motoristaIds, motoristaId } = req.query;
  if (!fecha) {
    return res.status(400).json({ error: 'La fecha es requerida.' });
  }
  if (sucursalId && !tieneAccesoSucursal(req, sucursalId)) {
    return res.status(403).json({ error: 'No tienes acceso a esta sucursal.' });
  }

  const filas = await obtenerFilasBoleta(req, fecha, sucursalId, motoristaIds || motoristaId);

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

function siNo(valor) {
  return valor ? 'Sí' : 'No';
}

// Dibuja la ficha de personal: encabezado (igual estilo que el resto de
// informes), foto a la derecha, y el resto de la información organizada
// en las mismas secciones que la pantalla de administración de Personal
// (Datos personales, Datos bancarios, Información laboral y personal,
// Datos de los padres, Documentos adjuntos).
function dibujarFichaPersonalPDF(doc, persona, rutaFoto) {
  const x = 40;
  const anchoUtil = doc.page.width - 80;
  const y0 = 40;

  doc.rect(x, y0, 260, 40).fillAndStroke('#EAEAEA', '#000000');
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(13)
    .text('FICHA DE PERSONAL', x + 10, y0 + 14, { width: 240 });
  doc.image(LOGO_MANDAME_PATH, x + anchoUtil - 150, y0, { width: 110 });

  let y = y0 + 52;

  function saltoDePaginaSiNecesario(alturaEstimada) {
    if (y + alturaEstimada > doc.page.height - 50) {
      doc.addPage();
      y = 40;
    }
  }

  function seccion(titulo) {
    saltoDePaginaSiNecesario(40);
    y += 6;
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0B5C4C').text(titulo.toUpperCase(), x, y);
    doc.moveTo(x, y + 14).lineTo(x + anchoUtil, y + 14).strokeColor('#CCCCCC').stroke();
    doc.fillColor('#000');
    y += 22;
  }

  // Cada fila mide su propio alto (las etiquetas y valores largos pueden
  // partirse en dos líneas) y recién entonces avanza "y" lo que hizo
  // falta — así ninguna fila se monta sobre la siguiente.
  function fila(pares) {
    const anchoCol = anchoUtil / pares.length;
    const anchoTexto = anchoCol - 10;
    let alturaMax = 0;

    saltoDePaginaSiNecesario(34);

    pares.forEach(([label, valor], idx) => {
      const cx = x + idx * anchoCol;
      doc.font('Helvetica-Bold').fontSize(8.5);
      const alturaLabel = doc.heightOfString(label.toUpperCase(), { width: anchoTexto });
      doc.text(label.toUpperCase(), cx, y, { width: anchoTexto });

      const yValor = y + alturaLabel + 3;
      doc.font('Helvetica').fontSize(9.5);
      const textoValor = valor || '—';
      doc.text(textoValor, cx, yValor, { width: anchoTexto });
      const alturaValor = doc.heightOfString(textoValor, { width: anchoTexto });

      alturaMax = Math.max(alturaMax, alturaLabel + 3 + alturaValor);
    });

    y += alturaMax + 12;
  }

  // Igual que fila(), pero para estados sí/no (documentos adjuntos): dibuja
  // el ✓ o la ✗ como trazos vectoriales en vez de caracteres de fuente,
  // porque Helvetica (la fuente estándar de PDFKit) no trae esos glifos.
  function filaEstados(pares) {
    const anchoCol = anchoUtil / pares.length;
    const anchoTexto = anchoCol - 10;
    const tamanoIcono = 9;
    let alturaMax = 0;

    saltoDePaginaSiNecesario(34);

    pares.forEach(([label, tiene], idx) => {
      const cx = x + idx * anchoCol;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000');
      const alturaLabel = doc.heightOfString(label.toUpperCase(), { width: anchoTexto });
      doc.text(label.toUpperCase(), cx, y, { width: anchoTexto });

      const yValor = y + alturaLabel + 3;
      const color = tiene ? '#0B5C4C' : '#9E2A2A';
      const iconoY = yValor + 1;

      doc.strokeColor(color).lineWidth(1.6);
      if (tiene) {
        doc.moveTo(cx, iconoY + 4.5).lineTo(cx + 3.5, iconoY + 8).lineTo(cx + tamanoIcono, iconoY).stroke();
      } else {
        doc.moveTo(cx, iconoY).lineTo(cx + tamanoIcono, iconoY + tamanoIcono)
          .moveTo(cx + tamanoIcono, iconoY).lineTo(cx, iconoY + tamanoIcono).stroke();
      }

      const textoValor = tiene ? 'Adjuntado' : 'No adjuntado';
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(color)
        .text(textoValor, cx + tamanoIcono + 6, yValor, { width: anchoTexto - tamanoIcono - 6 });
      doc.fillColor('#000');

      const alturaValor = doc.heightOfString(textoValor, { width: anchoTexto - tamanoIcono - 6 });
      alturaMax = Math.max(alturaMax, alturaLabel + 3 + Math.max(alturaValor, tamanoIcono));
    });

    y += alturaMax + 12;
  }

  // "Datos personales" va en un recuadro tipo currículum: la foto queda
  // dentro del mismo bloque, a la derecha, junto con los campos.
  {
    const anchoFoto = rutaFoto ? 95 : 0;
    const espacioFoto = rutaFoto ? anchoFoto + 16 : 0;
    const anchoTexto = anchoUtil - espacioFoto;
    const padding = 14;

    const filasPersonales = [
      [['Código', persona.codigo], ['Nombre completo', persona.nombres], ['DPI', persona.dpi]],
      [['Puesto', persona.puesto], ['CAD (sucursal)', persona.sucursalNombre], ['Estado', persona.estado === 'I' ? 'Dado de baja' : 'Activo']],
      [['Teléfono', persona.telefono], ['Correo electrónico', persona.correo]]
    ];

    function medirFila(pares, ancho) {
      const anchoCol = ancho / pares.length;
      const anchoCelda = anchoCol - 10;
      let alturaMax = 0;
      pares.forEach(([label, valor]) => {
        doc.font('Helvetica-Bold').fontSize(8.5);
        const alturaLabel = doc.heightOfString(label.toUpperCase(), { width: anchoCelda });
        doc.font('Helvetica').fontSize(9.5);
        const alturaValor = doc.heightOfString(valor || '—', { width: anchoCelda });
        alturaMax = Math.max(alturaMax, alturaLabel + 3 + alturaValor);
      });
      return alturaMax;
    }

    let alturaContenido = 22; // título de la sección + su línea
    filasPersonales.forEach((pares) => { alturaContenido += medirFila(pares, anchoTexto) + 12; });

    const alturaRecuadro = Math.max(alturaContenido, anchoFoto + padding * 2) + padding;
    saltoDePaginaSiNecesario(alturaRecuadro);

    doc.rect(x, y, anchoUtil, alturaRecuadro).strokeColor('#CCCCCC').lineWidth(1).stroke();

    if (rutaFoto) {
      try {
        doc.image(rutaFoto, x + anchoUtil - anchoFoto - padding, y + padding, { width: anchoFoto, height: anchoFoto, fit: [anchoFoto, anchoFoto] });
      } catch {
        // Si el archivo de foto no se puede leer, se omite sin romper la ficha.
      }
    }

    let yLocal = y + padding;
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0B5C4C').text('DATOS PERSONALES', x + padding, yLocal);
    doc.moveTo(x + padding, yLocal + 14).lineTo(x + anchoTexto - padding, yLocal + 14).strokeColor('#CCCCCC').stroke();
    doc.fillColor('#000');
    yLocal += 22;

    filasPersonales.forEach((pares) => {
      const anchoCol = anchoTexto / pares.length;
      const anchoCelda = anchoCol - 10;
      let alturaMax = 0;
      pares.forEach(([label, valor], idx) => {
        const cx = x + padding + idx * anchoCol;
        doc.font('Helvetica-Bold').fontSize(8.5);
        const alturaLabel = doc.heightOfString(label.toUpperCase(), { width: anchoCelda });
        doc.text(label.toUpperCase(), cx, yLocal, { width: anchoCelda });

        const yValor = yLocal + alturaLabel + 3;
        doc.font('Helvetica').fontSize(9.5);
        const textoValor = valor || '—';
        doc.text(textoValor, cx, yValor, { width: anchoCelda });
        const alturaValor = doc.heightOfString(textoValor, { width: anchoCelda });

        alturaMax = Math.max(alturaMax, alturaLabel + 3 + alturaValor);
      });
      yLocal += alturaMax + 12;
    });

    y += alturaRecuadro + 14;
  }

  seccion('Contacto de emergencia');
  fila([
    ['Nombre', persona.contactoEmergenciaNombre],
    ['Teléfono', persona.contactoEmergenciaTelefono],
    ['Relación', persona.contactoEmergenciaRelacion]
  ]);

  seccion('Datos bancarios');
  fila([['Número de cuenta', persona.numeroCuenta], ['Banco', persona.banco], ['Tipo de cuenta', persona.tipoCuenta]]);

  seccion('Información laboral y personal');
  fila([['IGSS', persona.igss], ['Estado civil', persona.estadoCivil], ['Nombre del cónyuge', persona.nombreConyuge]]);
  fila([
    ['Fecha inicio de labores', persona.fechaInicioLabores ? formatearFecha(persona.fechaInicioLabores) : ''],
    ['Fecha finaliza labores', persona.fechaFinLabores ? formatearFecha(persona.fechaFinLabores) : ''],
    ['Seguro de vida', siNo(persona.seguroVida)]
  ]);

  seccion('Datos de los padres');
  fila([['Nombre del padre', persona.nombrePadre], ['Nombre de la madre', persona.nombreMadre]]);

  if (persona.tambienMotorista) {
    seccion('Datos de motorista');
    fila([
      ['Tipo de motorista', persona.tipoMotorista === 'TURNO' ? 'Turno (sáb-dom)' : 'Fijo'],
      ['Placa asignada', persona.placa],
      ['Licencia de conducir', persona.licencia]
    ]);
  }

  seccion('Documentos adjuntos');
  filaEstados([
    ['DPI', !!persona.tieneDocDpi],
    ['Recibo de luz', !!persona.tieneDocReciboLuz],
    ['Licencia', !!persona.tieneDocLicencia]
  ]);
}

// GET /api/informes/ficha-personal?personaId=
// Genera la ficha completa de una persona (foto + toda la información
// capturada en Administración > Personal) en PDF. El listado de
// personas para elegir se arma con /informes/asistencia/motoristas
// (mismo filtro: motoristas activos de un CAD al que el usuario tenga acceso).
router.get('/ficha-personal', asyncHandler(async (req, res) => {
  const { personaId } = req.query;
  if (!personaId) {
    return res.status(400).json({ error: 'Debes seleccionar una persona.' });
  }

  const [[persona]] = await pool.query(
    `SELECT p.persona_id AS id, p.codigo_interno AS codigo,
            CONCAT(p.nombres,' ',p.apellidos) AS nombres,
            p.dpi, p.estado, cp.nombre AS puesto,
            s.sucursal_id AS sucursalId, s.nombre AS sucursalNombre,
            p.telefono, p.correo,
            p.contacto_emergencia_nombre AS contactoEmergenciaNombre,
            p.contacto_emergencia_telefono AS contactoEmergenciaTelefono,
            p.contacto_emergencia_relacion AS contactoEmergenciaRelacion,
            p.numero_cuenta AS numeroCuenta, p.banco, p.tipo_cuenta AS tipoCuenta,
            p.igss, p.estado_civil AS estadoCivil, p.nombre_conyuge AS nombreConyuge,
            p.nombre_padre AS nombrePadre, p.nombre_madre AS nombreMadre,
            p.fecha_inicio_labores AS fechaInicioLabores, p.fecha_fin_labores AS fechaFinLabores,
            p.seguro_vida AS seguroVida, p.foto_url AS fotoUrl,
            m.persona_id IS NOT NULL AS tambienMotorista, m.tipo_motorista AS tipoMotorista, m.placa, m.licencia,
            EXISTS(SELECT 1 FROM persona_documento pd WHERE pd.persona_id = p.persona_id AND pd.tipo = 'DPI') AS tieneDocDpi,
            EXISTS(SELECT 1 FROM persona_documento pd WHERE pd.persona_id = p.persona_id AND pd.tipo = 'RECIBO_LUZ') AS tieneDocReciboLuz,
            EXISTS(SELECT 1 FROM persona_documento pd WHERE pd.persona_id = p.persona_id AND pd.tipo = 'LICENCIA') AS tieneDocLicencia
     FROM persona p
     JOIN catalogo_puesto cp ON cp.puesto_id = p.puesto_id
     LEFT JOIN sucursal s ON s.sucursal_id = p.sucursal_base_id
     LEFT JOIN motorista m ON m.persona_id = p.persona_id
     WHERE p.persona_id = ?`,
    [personaId]
  );

  if (!persona) {
    return res.status(404).json({ error: 'Personal no encontrado.' });
  }
  if (persona.sucursalId && !tieneAccesoSucursal(req, persona.sucursalId)) {
    return res.status(403).json({ error: 'No tienes acceso a esta sucursal.' });
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="ficha-personal-${persona.codigo}.pdf"`);

  const doc = new PDFDocument({ margin: 0, size: 'LETTER' });
  doc.pipe(res);

  const rutaFoto = persona.fotoUrl && fs.existsSync(path.join(UPLOADS_DIR, persona.fotoUrl))
    ? path.join(UPLOADS_DIR, persona.fotoUrl)
    : null;
  dibujarFichaPersonalPDF(doc, persona, rutaFoto);

  doc.end();
}));

// Dibuja la tabla de "Asistencia general": mismas columnas que se ven en
// pantalla (Tienda, Codint, Nombre, Entrada, Salida, Repts, Tarifa), con
// encabezado repetido si el listado no cabe en una sola página.
function dibujarAsistenciaGeneralPDF(doc, filas, fecha) {
  const x = 40;
  const y0 = 40;
  const anchoUtil = doc.page.width - 80;

  const columnas = [
    { titulo: 'CAD', ancho: 0.20 },
    { titulo: 'COD', ancho: 0.09 },
    { titulo: 'NOMBRE', ancho: 0.26 },
    { titulo: 'ENTRADA', ancho: 0.13 },
    { titulo: 'SALIDA', ancho: 0.13 },
    { titulo: 'REPARTOS', ancho: 0.07 },
    { titulo: 'TARIFA', ancho: 0.12 }
  ].map((c) => ({ ...c, ancho: c.ancho * anchoUtil }));

  let y = y0;

  function encabezadoPagina() {
    doc.image(LOGO_MANDAME_PATH, x + anchoUtil - 110, y, { width: 110 });
    doc.font('Helvetica-Bold').fontSize(16).text('Asistencia general', x, y);
    doc.font('Helvetica').fontSize(10).fillColor('#5B6270').text(`Fecha: ${formatearFecha(fecha)}`, x, y + 20);
    doc.fillColor('#000');
    y += 50;
    encabezadoTabla();
  }

  function encabezadoTabla() {
    let cx = x;
    columnas.forEach((col) => {
      doc.rect(cx, y, col.ancho, 22).fillAndStroke('#EAEAEA', '#000000');
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(8.5)
        .text(col.titulo, cx + 4, y + 7, { width: col.ancho - 8, align: 'left' });
      cx += col.ancho;
    });
    y += 22;
  }

  function saltoDePaginaSiNecesario(alturaFila) {
    if (y + alturaFila > doc.page.height - 50) {
      doc.addPage();
      y = 40;
      encabezadoTabla();
    }
  }

  encabezadoPagina();

  if (filas.length === 0) {
    doc.font('Helvetica').fontSize(11).text('No hay motoristas con asistencia y cierre de turno para esta fecha.', x, y + 10);
    return;
  }

  filas.forEach((fila) => {
    const valores = [
      fila.sucursal || '',
      fila.codigo != null ? String(fila.codigo) : '',
      fila.nombre || '',
      fila.horaIngreso || '—',
      fila.horaSalida || '—',
      fila.cantidadRepartos != null ? String(fila.cantidadRepartos) : '0',
      fila.tarifa || '—'
    ];

    let alturaFila = 0;
    valores.forEach((valor, idx) => {
      doc.font('Helvetica').fontSize(8.5);
      alturaFila = Math.max(alturaFila, doc.heightOfString(valor, { width: columnas[idx].ancho - 8 }));
    });
    alturaFila += 10;

    saltoDePaginaSiNecesario(alturaFila);

    let cx = x;
    valores.forEach((valor, idx) => {
      doc.rect(cx, y, columnas[idx].ancho, alturaFila).strokeColor('#DDDDDD').stroke();
      doc.font('Helvetica').fontSize(8.5).fillColor('#000')
        .text(valor, cx + 4, y + 5, { width: columnas[idx].ancho - 8 });
      cx += columnas[idx].ancho;
    });

    y += alturaFila;
  });

  saltoDePaginaSiNecesario(24);
  y += 10;
  doc.font('Helvetica-Bold').fontSize(10)
    .text(`Total con asistencia y cierre de turno: ${filas.length}`, x, y);
}

// GET /api/informes/asistencia-general/preview?fecha=&sucursalId=
// Sin sucursalId trae todas las CAD a las que el usuario tiene acceso
// (igual que /boleta). Reusa la misma consulta que boleta: motoristas con
// asistencia y cierre de turno (reparto autorizado) en esa fecha.
router.get('/asistencia-general/preview', asyncHandler(async (req, res) => {
  const { fecha, sucursalId } = req.query;
  if (!fecha) {
    return res.status(400).json({ error: 'La fecha es requerida.' });
  }
  if (sucursalId && !tieneAccesoSucursal(req, sucursalId)) {
    return res.status(403).json({ error: 'No tienes acceso a esta sucursal.' });
  }

  const filas = await obtenerFilasBoleta(req, fecha, sucursalId);
  res.json(filas);
}));

// GET /api/informes/asistencia-general?fecha=&sucursalId=
router.get('/asistencia-general', asyncHandler(async (req, res) => {
  const { fecha, sucursalId } = req.query;
  if (!fecha) {
    return res.status(400).json({ error: 'La fecha es requerida.' });
  }
  if (sucursalId && !tieneAccesoSucursal(req, sucursalId)) {
    return res.status(403).json({ error: 'No tienes acceso a esta sucursal.' });
  }

  const filas = await obtenerFilasBoleta(req, fecha, sucursalId);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="asistencia-general-${fecha}.pdf"`);

  const doc = new PDFDocument({ margin: 0, size: 'LETTER', layout: 'landscape' });
  doc.pipe(res);
  dibujarAsistenciaGeneralPDF(doc, filas, fecha);
  doc.end();
}));

export default router;
