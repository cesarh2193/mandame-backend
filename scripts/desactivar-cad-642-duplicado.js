// Se creó por error un segundo CAD con código 642 (ESQUIPULAS), sin
// validación que lo impidiera (ver fix en empresas.routes.js). Los dos:
//   - sucursal_id 48 "ESQUIPULAS " — el real: tiene asignación,
//     planificación y reparto, incluida la asignación de hoy.
//   - sucursal_id 56 "ESQUIPULAS"  — el duplicado vacío: 0 asignaciones,
//     0 planificaciones, 0 cierres en toda su historia.
// Se desactiva el 56 (no se elimina, por si hiciera falta auditarlo
// después) para que deje de aparecer en cualquier selector.
import { pool } from '../src/config/db.js';

const [resultado] = await pool.query(`UPDATE sucursal SET estado = 'I' WHERE sucursal_id = 56`);
console.log(`OK: sucursal_id 56 desactivada (${resultado.affectedRows} fila actualizada).`);

await pool.end();
