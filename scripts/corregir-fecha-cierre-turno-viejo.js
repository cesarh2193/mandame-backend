// sp_cerrar_turno usaba SIEMPRE CURDATE() como fecha del reparto,
// sin importar cuándo se marcó el ingreso real. Eso rompía dos casos:
//
// 1. Un turno que se queda "en turno" abierto de un día para otro
//    (nadie marcó salida antes de medianoche) no se podía volver a
//    cerrar nunca desde la pantalla normal: el flujo de Cierre de
//    turno siempre intenta "corregir" el ingreso primero, y ese paso
//    exige que el ingreso sea de HOY — si ya pasaron días, no lo
//    encuentra y rechaza el cierre entero con "Esta asignación no
//    tiene un ingreso registrado hoy." (ver cierreTurno.routes.js,
//    sp_corregir_ingreso). El frontend se corrigió aparte para dejar
//    de mandar la hora de ingreso cuando el usuario no la tocó, así
//    ese paso ya ni se ejecuta para un turno viejo.
// 2. Aunque se lograra cerrar (ej. reconstruyendo el reparto a mano,
//    como con la asignación 262 semanas atrás), si se cerraba días
//    después el reparto quedaba fechado el día en que alguien lo
//    cerró, no el día en que el motorista trabajó — reventando el
//    Informe Semanal de la semana real trabajada.
//
// Este script corrige sp_cerrar_turno para que la fecha del reparto
// salga de la marca de INGRESO real de esa asignación (la más
// reciente), en vez de CURDATE(). Un turno cerrado el mismo día sigue
// comportándose exactamente igual que antes (el ingreso de hoy sigue
// siendo hoy); el único caso que cambia es un turno viejo, que ahora
// sí se puede cerrar y queda fechado el día correcto.
import { pool } from '../src/config/db.js';

await pool.query('DROP PROCEDURE IF EXISTS sp_cerrar_turno');
await pool.query(`
CREATE DEFINER=\`devmandame\`@\`%\` PROCEDURE sp_cerrar_turno(
  IN p_asignacion_id INT,
  IN p_cantidad_entregas INT,
  IN p_tarifa_id INT,
  IN p_tipo_consumo VARCHAR(20),
  IN p_es_extra TINYINT(1),
  IN p_observacion VARCHAR(150),
  IN p_usuario_id INT,
  IN p_hora_salida DATETIME
)
BEGIN
  DECLARE v_fecha DATE;
  DECLARE v_hora_salida DATETIME DEFAULT COALESCE(p_hora_salida, NOW());
  DECLARE v_reparto_id INT;

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  SELECT DATE(fecha_hora) INTO v_fecha
  FROM asistencia_marca
  WHERE asignacion_id = p_asignacion_id
    AND tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'INGRESO')
  ORDER BY fecha_hora DESC
  LIMIT 1;

  IF v_fecha IS NULL THEN
    SET v_fecha = CURDATE();
  END IF;

  START TRANSACTION;

  INSERT INTO asistencia_marca (asignacion_id, tipo_marca_id, fecha_hora, usuario_registro_id)
  VALUES (
    p_asignacion_id,
    (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'SALIDA'),
    v_hora_salida,
    p_usuario_id
  );

  INSERT INTO reparto
    (asignacion_id, fecha, cantidad_entregas, tarifa_id, tipo_consumo, es_extra, observacion, estado, usuario_crea_id)
  VALUES
    (p_asignacion_id, v_fecha, p_cantidad_entregas, p_tarifa_id, p_tipo_consumo, p_es_extra, p_observacion, 'PENDIENTE', p_usuario_id);

  SET v_reparto_id = LAST_INSERT_ID();

  COMMIT;

  SELECT v_reparto_id AS repartoId;
END
`);
console.log('sp_cerrar_turno recreado OK (fecha del reparto = fecha real del ingreso, no CURDATE())');

await pool.end();
