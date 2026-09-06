// sp_cerrar_turno y sp_revertir_cierre abren una transacción explícita
// (START TRANSACTION ... COMMIT) pero no tenían ningún manejo de error.
// Si algo fallaba a mitad de camino (ej. un duplicado en asistencia_marca),
// el procedimiento se cortaba SIN hacer ROLLBACK, y la conexión —todavía
// a medias en esa transacción— volvía al pool de Node y se reusaba en
// la siguiente petición de cualquier otro usuario, sin relación alguna.
//
// Caso real que destapó esto: asignación 262 (05/09/2026) quedó con la
// marca de SALIDA guardada pero sin su reparto — sp_cerrar_turno falló
// entre esos dos INSERT y nunca deshizo el primero. Cada reintento
// posterior chocaba con "ya existe esa salida" (Duplicate entry) sin
// poder completar el cierre.
//
// Este script agrega un `DECLARE EXIT HANDLER FOR SQLEXCEPTION` a los
// dos procedimientos que manejan transacción propia, para que cualquier
// error a mitad de camino haga ROLLBACK antes de devolver el error —
// así la conexión siempre vuelve limpia al pool.
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
  DECLARE v_fecha DATE DEFAULT CURDATE();
  DECLARE v_hora_salida DATETIME DEFAULT COALESCE(p_hora_salida, NOW());
  DECLARE v_reparto_id INT;

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

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
console.log('sp_cerrar_turno recreado OK');

await pool.query('DROP PROCEDURE IF EXISTS sp_revertir_cierre');
await pool.query(`
CREATE DEFINER=\`devmandame\`@\`%\` PROCEDURE sp_revertir_cierre(
  IN p_reparto_id INT,
  IN p_usuario_admin_id INT
)
BEGIN
  DECLARE v_asignacion_id INT;
  DECLARE v_sucursal_id INT;
  DECLARE v_fecha DATE;
  DECLARE v_estado_previo VARCHAR(20);

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  SELECT r.asignacion_id, r.fecha, r.estado, a.sucursal_id
    INTO v_asignacion_id, v_fecha, v_estado_previo, v_sucursal_id
  FROM reparto r
  JOIN asignacion a ON a.asignacion_id = r.asignacion_id
  WHERE r.reparto_id = p_reparto_id;

  IF v_asignacion_id IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'No existe ese cierre.';
  END IF;

  IF v_estado_previo = 'ANULADO' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Este cierre ya estaba anulado.';
  END IF;

  START TRANSACTION;

  DELETE FROM asistencia_marca
  WHERE asignacion_id = v_asignacion_id
    AND tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'SALIDA')
    AND DATE(fecha_hora) = v_fecha;

  UPDATE reparto SET estado = 'ANULADO' WHERE reparto_id = p_reparto_id;

  UPDATE cierre_dia cd
  SET
    motoristas_asistieron = (
      SELECT COUNT(DISTINCT am.asignacion_id)
      FROM reparto r2
      JOIN asignacion a2 ON a2.asignacion_id = r2.asignacion_id
      LEFT JOIN asistencia_marca am
        ON am.asignacion_id = r2.asignacion_id
       AND am.tipo_marca_id = (SELECT tipo_marca_id FROM catalogo_tipo_marca WHERE nombre = 'INGRESO')
      WHERE r2.estado = 'AUTORIZADO' AND a2.sucursal_id = v_sucursal_id AND r2.fecha = v_fecha
    ),
    entregas_total = (
      SELECT COALESCE(SUM(r2.cantidad_entregas), 0)
      FROM reparto r2
      JOIN asignacion a2 ON a2.asignacion_id = r2.asignacion_id
      WHERE r2.estado = 'AUTORIZADO' AND a2.sucursal_id = v_sucursal_id AND r2.fecha = v_fecha
    )
  WHERE cd.sucursal_id = v_sucursal_id AND cd.fecha = v_fecha;

  INSERT INTO auditoria (tabla, registro_id, accion, usuario_id, valores_antes, valores_despues)
  VALUES ('reparto', p_reparto_id, 'UPDATE', p_usuario_admin_id,
    JSON_OBJECT('estado', v_estado_previo),
    JSON_OBJECT('estado', 'ANULADO', 'asignacion_id', v_asignacion_id));

  COMMIT;

  SELECT v_asignacion_id AS asignacionId, v_sucursal_id AS sucursalId;
END
`);
console.log('sp_revertir_cierre recreado OK');

await pool.end();
