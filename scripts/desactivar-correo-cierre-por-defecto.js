// Por pedido explícito: hasta que se decida quiénes realmente
// necesitan el correo automático de resumen de cierre, que por ahora
// NO le llegue a nadie. Pone 'N' a todos los usuarios existentes y
// cambia el default de la columna a 'N', para que cualquier usuario
// nuevo también arranque sin recibirlo hasta que alguien lo active a
// mano desde Usuarios y permisos.
import { pool } from '../src/config/db.js';

const [resultado] = await pool.query(`UPDATE usuario SET recibir_notificaciones_cierre = 'N'`);
console.log(`OK: ${resultado.affectedRows} usuario(s) actualizados a 'N'.`);

await pool.query(`ALTER TABLE usuario ALTER COLUMN recibir_notificaciones_cierre SET DEFAULT 'N'`);
console.log('OK: el default de la columna ahora es \'N\' para usuarios nuevos.');

await pool.end();
