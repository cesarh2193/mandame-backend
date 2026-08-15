import { pool } from '../src/config/db.js';

// 1) Nuevo estado ANULADO para reparto — todas las consultas del
//    sistema filtran por igualdad ('AUTORIZADO' o 'PENDIENTE'), nunca
//    por exclusión, así que agregar un valor al enum no rompe nada
//    existente: un reparto ANULADO simplemente deja de aparecer en
//    boletas, informes y "Autorizados hoy".
await pool.query(
  `ALTER TABLE reparto
   MODIFY estado ENUM('BORRADOR','PENDIENTE','AUTORIZADO','RECHAZADO','ANULADO') NOT NULL DEFAULT 'BORRADOR'`
);
console.log('OK: reparto.estado admite ANULADO');

// 2) sp_revertir_cierre — solo Administrador (se valida en Node, no
//    acá). Deshace un cierre por error: borra la marca de SALIDA de
//    ese día (así el motorista vuelve a aparecer "en turno" y se
//    puede volver a cerrar bien), marca el reparto como ANULADO (no
//    se borra: queda trazabilidad) y recalcula cierre_dia para no
//    dejar el resumen del CAD con datos de un cierre que ya no cuenta.
await pool.query('DROP PROCEDURE IF EXISTS sp_revertir_cierre');
await pool.query(`
CREATE PROCEDURE sp_revertir_cierre(
  IN p_reparto_id INT,
  IN p_usuario_admin_id INT
)
BEGIN
  DECLARE v_asignacion_id INT;
  DECLARE v_sucursal_id INT;
  DECLARE v_fecha DATE;
  DECLARE v_estado_previo VARCHAR(20);

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
console.log('OK: sp_revertir_cierre creado');

await pool.end();
