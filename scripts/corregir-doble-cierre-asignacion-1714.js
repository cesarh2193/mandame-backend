// Caso real: la asignación 1714 (motorista 231, CAD 15, 10/10/2026) se
// cerró dos veces. Primer intento con la hora de salida mal escrita
// (fecha 2026-09-10 en vez de 2026-10-10 — típico error de un mes en
// el selector) creó el reparto 1790 y la marca de SALIDA 3663 con esa
// fecha equivocada. El reintento con la fecha corregida no chocó
// contra nada (la fecha ya era distinta) y creó un segundo reparto
// válido, el 1794, con la marca de SALIDA 3669 (fecha correcta).
// Resultado: 32 entregas contadas en vez de 16, y esta es la única
// asignación en toda la base con más de un reparto activo.
//
// Se anula el reparto equivocado (1790) y se borra la marca de SALIDA
// con la fecha mal escrita (3663, dato basura sin ningún otro
// propósito), dejando el reparto 1794 (con su SALIDA real, 3669) como
// el cierre válido. Se recalcula cierre_dia del CAD/fecha afectado.
import { pool } from '../src/config/db.js';

const REPARTO_ANULAR = 1790;
const MARCA_BORRAR = 3663;
const SUCURSAL_ID = 15;
const FECHA = '2026-10-10';

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();

  const [[repartoActual]] = await conn.query('SELECT estado FROM reparto WHERE reparto_id = ?', [REPARTO_ANULAR]);
  if (!repartoActual || repartoActual.estado === 'ANULADO') {
    throw new Error(`El reparto ${REPARTO_ANULAR} no existe o ya está anulado — revisar antes de continuar.`);
  }

  await conn.query(`UPDATE reparto SET estado = 'ANULADO' WHERE reparto_id = ?`, [REPARTO_ANULAR]);
  console.log(`OK: reparto ${REPARTO_ANULAR} marcado ANULADO.`);

  const [resultadoMarca] = await conn.query('DELETE FROM asistencia_marca WHERE marca_id = ?', [MARCA_BORRAR]);
  console.log(`OK: marca ${MARCA_BORRAR} eliminada (${resultadoMarca.affectedRows} fila).`);

  await conn.query(
    `UPDATE cierre_dia cd
     SET
       motoristas_asistieron = (
         SELECT COUNT(DISTINCT am.asignacion_id)
         FROM reparto r2
         JOIN asignacion a2 ON a2.asignacion_id = r2.asignacion_id
         LEFT JOIN asistencia_marca am
           ON am.asignacion_id = r2.asignacion_id
          AND am.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'INGRESO')
         WHERE r2.estado = 'AUTORIZADO' AND a2.sucursal_id = ? AND r2.fecha = ?
       ),
       entregas_total = (
         SELECT COALESCE(SUM(r2.cantidad_entregas), 0)
         FROM reparto r2
         JOIN asignacion a2 ON a2.asignacion_id = r2.asignacion_id
         WHERE r2.estado = 'AUTORIZADO' AND a2.sucursal_id = ? AND r2.fecha = ?
       )
     WHERE cd.sucursal_id = ? AND cd.fecha = ?`,
    [SUCURSAL_ID, FECHA, SUCURSAL_ID, FECHA, SUCURSAL_ID, FECHA]
  );
  const [[cierreDespues]] = await conn.query(
    'SELECT motoristas_asistieron, entregas_total FROM cierre_dia WHERE sucursal_id = ? AND fecha = ?',
    [SUCURSAL_ID, FECHA]
  );
  console.log('OK: cierre_dia recalculado ->', JSON.stringify(cierreDespues));

  await conn.query(
    `INSERT INTO auditoria (tabla, registro_id, accion, usuario_id, valores_antes, valores_despues, fecha)
     VALUES ('reparto', ?, 'UPDATE', NULL, JSON_OBJECT('estado','AUTORIZADO'), JSON_OBJECT('estado','ANULADO','motivo','Doble cierre por typo de fecha (09-10 vs 10-10), corregido por script'), NOW())`,
    [REPARTO_ANULAR]
  );

  await conn.commit();
  console.log('Listo.');
} catch (err) {
  await conn.rollback();
  console.error('FALLÓ, se revirtió todo:', err.message);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
