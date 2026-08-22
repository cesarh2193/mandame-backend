import { Router } from 'express';
import PDFDocument from 'pdfkit';
import { pool } from '../config/db.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(authenticate, requireRole('Admin', 'Gerente'));

async function obtenerFilasMonitoreo(fecha) {
  const [rows] = await pool.query(
    `SELECT s.sucursal_id AS sucursalId, s.nombre AS sucursal,
            SUM(CASE WHEN m.tipo_motorista = 'FIJO' THEN 1 ELSE 0 END) AS fijo,
            SUM(CASE WHEN m.tipo_motorista = 'TURNO' THEN 1 ELSE 0 END) AS turno,
            COALESCE(pl.motoristas_plan, 0) AS plan,
            COUNT(DISTINCT ing.asignacion_id) AS asistencia,
            CASE
              WHEN COALESCE(pl.motoristas_plan, 0) = 0 THEN 0
              ELSE ROUND(COUNT(DISTINCT ing.asignacion_id) / COALESCE(pl.motoristas_plan, 1) * 100, 0)
            END AS porcentaje
     FROM sucursal s
     LEFT JOIN planificacion pl ON pl.sucursal_id = s.sucursal_id AND pl.fecha = ?
     LEFT JOIN asignacion a ON a.sucursal_id = s.sucursal_id AND ? BETWEEN a.fecha_inicio AND a.fecha_fin
     LEFT JOIN motorista m ON m.persona_id = a.motorista_id
     LEFT JOIN asistencia_marca ing
       ON ing.asignacion_id = a.asignacion_id
      AND ing.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'INGRESO')
      AND DATE(ing.fecha_hora) = ?
     WHERE s.estado = 'A'
     GROUP BY s.sucursal_id, s.nombre, pl.motoristas_plan
     ORDER BY s.nombre`,
    [fecha, fecha, fecha]
  );
  return rows;
}

// GET /api/monitoreo?fecha=
router.get('/', asyncHandler(async (req, res) => {
  const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);
  res.json(await obtenerFilasMonitoreo(fecha));
}));

// GET /api/monitoreo/pdf?fecha=
// Mismo criterio que la pantalla: separa los CAD que sí tuvieron
// planificación o asistencia hoy de los que no han tenido ningún
// movimiento, para poder detectar de un vistazo cuáles todavía no
// arrancan turno (ver Monitoreo.jsx en el frontend).
router.get('/pdf', asyncHandler(async (req, res) => {
  const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);
  const filas = await obtenerFilasMonitoreo(fecha);
  const conMovimiento = filas.filter((f) => Number(f.plan) > 0 || Number(f.asistencia) > 0);
  const sinMovimiento = filas.filter((f) => !(Number(f.plan) > 0 || Number(f.asistencia) > 0));

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="monitoreo-${fecha}.pdf"`);

  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(res);

  const columnas = ['CAD', 'Fijo', 'Turno', 'Plan.', 'Asis.', '%'];
  const anchos = [180, 60, 60, 60, 60, 60];
  let y = 40;

  function saltoDePaginaSiNecesario(alturaEstimada) {
    if (y + alturaEstimada > doc.page.height - 50) {
      doc.addPage();
      y = 40;
    }
  }

  function encabezadoTabla() {
    columnas.forEach((c, i) => {
      doc.font('Helvetica-Bold').fontSize(10).text(c, 40 + anchos.slice(0, i).reduce((a, b) => a + b, 0), y, { width: anchos[i] });
    });
    y += 18;
    doc.moveTo(40, y).lineTo(500, y).stroke();
    y += 6;
  }

  function tabla(filasGrupo) {
    encabezadoTabla();
    filasGrupo.forEach((f) => {
      saltoDePaginaSiNecesario(18);
      const valores = [f.sucursal, f.fijo, f.turno, f.plan, f.asistencia, `${f.porcentaje}%`];
      valores.forEach((v, i) => {
        doc.font('Helvetica').fontSize(10).text(String(v), 40 + anchos.slice(0, i).reduce((a, b) => a + b, 0), y, { width: anchos[i] });
      });
      y += 18;
    });
  }

  doc.font('Helvetica-Bold').fontSize(16).text(`Monitoreo — ${fecha}`, 40, y);
  y += 30;

  saltoDePaginaSiNecesario(40);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#0B5C4C')
    .text(`CAD con planificación o asignación hoy (${conMovimiento.length})`, 40, y);
  doc.fillColor('#000');
  y += 22;
  if (conMovimiento.length > 0) {
    tabla(conMovimiento);
  } else {
    doc.font('Helvetica').fontSize(10).fillColor('#666').text('Ningún CAD tiene movimiento registrado todavía hoy.', 40, y);
    doc.fillColor('#000');
    y += 18;
  }
  y += 20;

  saltoDePaginaSiNecesario(60);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#0B5C4C')
    .text(`CAD sin movimiento hoy (${sinMovimiento.length})`, 40, y);
  doc.fillColor('#000');
  y += 18;
  doc.font('Helvetica').fontSize(9).fillColor('#666')
    .text('Sin planificación ni asignación registrada — todavía no han hecho uso del sistema para turnos.', 40, y, { width: 460 });
  doc.fillColor('#000');
  y += 20;
  if (sinMovimiento.length > 0) {
    tabla(sinMovimiento);
  } else {
    doc.font('Helvetica').fontSize(10).fillColor('#666').text('Todos los CAD tienen movimiento registrado hoy.', 40, y);
    doc.fillColor('#000');
  }

  doc.end();
}));

export default router;
