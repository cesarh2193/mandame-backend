// sp_autorizar_repartos recalculaba cierre_dia (y los gerentes a
// notificar) para TODOS los CAD con actividad hoy, no solo el CAD que
// se estaba autorizando en esa llamada. Eso hacía que autorizaciones
// simultáneas en CADs distintos pelearan por las mismas filas de
// cierre_dia y producía "Lock wait timeout exceeded" (visto en
// /api/cierre-turno/221, usuario 51) — el cierre quedaba guardado pero
// la autorización automática se caía a mitad de camino. De paso,
// también hacía que los Gerentes recibieran el correo de resumen de
// CADs ajenos cada vez que se autorizaba algo en cualquier otro lado.
//
// Este script reemplaza el procedimiento para que solo toque las
// sucursales que efectivamente se autorizaron en la llamada (usando
// una tabla temporal para llevar el registro).
import { pool } from '../src/config/db.js';

await pool.query('DROP PROCEDURE IF EXISTS sp_autorizar_repartos');

const sql = `
CREATE DEFINER=\`devmandame\`@\`%\` PROCEDURE sp_autorizar_repartos(
  IN p_reparto_ids TEXT,
  IN p_usuario_id INT
)
BEGIN
  DECLARE v_id INT;
  DECLARE v_siguiente INT;
  DECLARE v_restante TEXT;

  DROP TEMPORARY TABLE IF EXISTS tmp_sucursales_tocadas;
  CREATE TEMPORARY TABLE tmp_sucursales_tocadas (sucursal_id INT PRIMARY KEY);

  SET v_restante = CONCAT(p_reparto_ids, ',');

  -- 1) marcar cada reparto como autorizado, y anotar su sucursal
  WHILE LENGTH(v_restante) > 0 DO
    SET v_siguiente = LOCATE(',', v_restante);
    SET v_id = CAST(TRIM(SUBSTRING(v_restante, 1, v_siguiente - 1)) AS UNSIGNED);
    SET v_restante = SUBSTRING(v_restante, v_siguiente + 1);

    IF v_id IS NOT NULL AND v_id > 0 THEN
      UPDATE reparto
      SET estado = 'AUTORIZADO', usuario_autoriza_id = p_usuario_id, fecha_autoriza = NOW()
      WHERE reparto_id = v_id AND estado <> 'AUTORIZADO';

      INSERT IGNORE INTO tmp_sucursales_tocadas (sucursal_id)
      SELECT a.sucursal_id FROM reparto r JOIN asignacion a ON a.asignacion_id = r.asignacion_id
      WHERE r.reparto_id = v_id;
    END IF;
  END WHILE;

  -- 2) recalcular cierre_dia SOLO para las sucursales tocadas en esta
  --    llamada (antes recalculaba TODAS las que tuvieran actividad hoy
  --    en cualquier CAD, lo que hacía pelear por los mismos renglones
  --    a autorizaciones simultáneas de CADs distintos y producía
  --    "Lock wait timeout" cuando coincidían dos supervisores a la vez)
  INSERT INTO cierre_dia (sucursal_id, fecha, motoristas_plan, motoristas_asistieron, entregas_total, estado)
  SELECT
    a.sucursal_id,
    r.fecha,
    COALESCE((SELECT motoristas_plan FROM planificacion pl WHERE pl.sucursal_id = a.sucursal_id AND pl.fecha = r.fecha), 0),
    COUNT(DISTINCT am.asignacion_id),
    SUM(r.cantidad_entregas),
    'AUTORIZADO'
  FROM reparto r
  JOIN asignacion a ON a.asignacion_id = r.asignacion_id
  LEFT JOIN asistencia_marca am
    ON am.asignacion_id = r.asignacion_id
   AND am.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'INGRESO')
  WHERE r.estado = 'AUTORIZADO'
    AND r.fecha = CURDATE()
    AND a.sucursal_id IN (SELECT sucursal_id FROM tmp_sucursales_tocadas)
  GROUP BY a.sucursal_id, r.fecha
  ON DUPLICATE KEY UPDATE
    motoristas_asistieron = VALUES(motoristas_asistieron),
    entregas_total = VALUES(entregas_total),
    estado = 'AUTORIZADO',
    usuario_autoriza_id = p_usuario_id,
    fecha_autoriza = NOW();

  -- 3) gerentes a notificar, solo de las sucursales tocadas en esta llamada
  SELECT DISTINCT u.email, u.usuario_id, cd.sucursal_id, s.nombre AS sucursal_nombre
  FROM cierre_dia cd
  JOIN sucursal s ON s.sucursal_id = cd.sucursal_id
  JOIN usuario_sucursal us ON us.sucursal_id = cd.sucursal_id
  JOIN usuario u ON u.usuario_id = us.usuario_id
  JOIN usuario_rol ur ON ur.usuario_id = u.usuario_id
  JOIN rol r2 ON r2.rol_id = ur.rol_id AND r2.nombre = 'Gerente'
  WHERE cd.fecha = CURDATE()
    AND cd.sucursal_id IN (SELECT sucursal_id FROM tmp_sucursales_tocadas)
    AND u.email IS NOT NULL;

  DROP TEMPORARY TABLE IF EXISTS tmp_sucursales_tocadas;
END`;

await pool.query(sql);
console.log('Procedimiento recreado OK');

const [check] = await pool.query('SHOW CREATE PROCEDURE sp_autorizar_repartos');
console.log(check[0]['Create Procedure']);

await pool.end();
