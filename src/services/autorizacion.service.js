import { pool, callProcedure } from '../config/db.js';
import { enviarResumenGerente, enviarCierreCadPDF } from '../utils/mailer.js';
import { obtenerFilasBoleta } from '../routes/informes.routes.js';
import { generarPDFCierreCad } from '../utils/pdfCierreCad.js';

/**
 * Marca los repartos como autorizados (sp_autorizar_repartos) y
 * dispara el correo de resumen a los Gerentes con acceso a cada
 * sucursal tocada. Usado tanto por /autorizacion/autorizar como por
 * el cierre-de-turno de un solo paso (que autoriza al guardar).
 */
export async function autorizarYNotificar(repartoIds, usuarioId) {
  const gerentes = await callProcedure('sp_autorizar_repartos', [repartoIds.join(','), usuarioId]);
  const fecha = new Date().toISOString().slice(0, 10);

  for (const g of gerentes) {
    const [[resumen]] = await pool.query(
      `SELECT motoristas_plan AS motoristasPlan, motoristas_asistieron AS motoristasAsistieron,
              entregas_total AS entregasTotal, porcentaje_cumplimiento AS porcentaje
       FROM cierre_dia WHERE sucursal_id = ? AND fecha = CURDATE()`,
      [g.sucursal_id]
    );
    enviarResumenGerente({
      para: g.email,
      sucursalNombre: g.sucursal_nombre,
      fecha,
      resumen: resumen || { motoristasPlan: 0, motoristasAsistieron: 0, entregasTotal: 0, porcentaje: 0 }
    }).catch((err) => console.error('No se pudo enviar el correo de resumen:', err.message));
  }

  // Además, por cada sucursal tocada: si ya no queda ningún motorista
  // en turno hoy (todos cerraron), se manda un correo aparte con el
  // PDF del listado completo del día a sus Gerentes.
  const sucursalesTocadas = [...new Set(gerentes.map((g) => g.sucursal_id))];
  for (const sucursalId of sucursalesTocadas) {
    const gerentesSucursal = gerentes.filter((g) => g.sucursal_id === sucursalId);
    notificarSiCadFinalizado(sucursalId, fecha, gerentesSucursal)
      .catch((err) => console.error('No se pudo notificar el cierre del CAD:', err.message));
  }

  return { autorizados: repartoIds.length, correosEnviados: gerentes.length };
}

async function notificarSiCadFinalizado(sucursalId, fecha, gerentesSucursal) {
  if (gerentesSucursal.length === 0) return;

  const [[{ pendientes }]] = await pool.query(
    `SELECT COUNT(*) AS pendientes
     FROM asignacion a
     JOIN asistencia_marca ing ON ing.asignacion_id = a.asignacion_id
       AND ing.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'INGRESO')
       AND DATE(ing.fecha_hora) = CURDATE()
     LEFT JOIN asistencia_marca sal ON sal.asignacion_id = a.asignacion_id
       AND sal.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'SALIDA')
       AND DATE(sal.fecha_hora) = CURDATE()
     WHERE a.sucursal_id = ? AND sal.marca_id IS NULL`,
    [sucursalId]
  );
  if (pendientes > 0) return;

  const filas = await obtenerFilasBoleta({}, fecha, sucursalId);
  if (filas.length === 0) return;

  const sucursalNombre = gerentesSucursal[0].sucursal_nombre;
  const pdfBuffer = await generarPDFCierreCad(filas, sucursalNombre, fecha);

  for (const g of gerentesSucursal) {
    await enviarCierreCadPDF({ para: g.email, sucursalNombre, fecha, pdfBuffer });
  }
}
