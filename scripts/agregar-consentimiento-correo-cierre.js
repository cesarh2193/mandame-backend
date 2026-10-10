// Los correos automáticos de "resumen de cierre" y "CAD finalizado" se
// mandaban siempre a todo Gerente con acceso a esa sucursal, sin que
// nadie pudiera optar por no recibirlos. Se agrega una columna para que
// cada usuario decida si los quiere recibir — por defecto 'S' (Sí),
// para no cambiarle el comportamiento a nadie que no lo haya pedido.
import { pool } from '../src/config/db.js';

await pool.query(`
  ALTER TABLE usuario
  ADD COLUMN recibir_notificaciones_cierre ENUM('S','N') NOT NULL DEFAULT 'S'
  AFTER email
`);
console.log('OK: usuario.recibir_notificaciones_cierre agregada (default S para todos los existentes).');

await pool.end();
