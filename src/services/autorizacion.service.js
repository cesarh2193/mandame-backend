import { pool, callProcedure } from '../config/db.js';
import { enviarResumenGerente } from '../utils/mailer.js';

/**
 * Marca los repartos como autorizados (sp_autorizar_repartos) y
 * dispara el correo de resumen a los Gerentes con acceso a cada
 * sucursal tocada. Usado tanto por /autorizacion/autorizar como por
 * el cierre-de-turno de un solo paso (que autoriza al guardar).
 */
export async function autorizarYNotificar(repartoIds, usuarioId) {
  const gerentes = await callProcedure('sp_autorizar_repartos', [repartoIds.join(','), usuarioId]);

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
      fecha: new Date().toISOString().slice(0, 10),
      resumen: resumen || { motoristasPlan: 0, motoristasAsistieron: 0, entregasTotal: 0, porcentaje: 0 }
    }).catch((err) => console.error('No se pudo enviar el correo de resumen:', err.message));
  }

  return { autorizados: repartoIds.length, correosEnviados: gerentes.length };
}
