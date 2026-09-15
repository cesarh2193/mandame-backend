// 1) Separa "Inactivo" (I) de "Eliminado" (E): los que hoy están en I
//    pasan a E con su código en 0 (ya liberado). De aquí en adelante, ni
//    I ni E deben aparecer en ninguna pantalla operativa ni en el
//    catálogo de Personal (ver personal.routes.js GET /).
// 2) Renumera a todo el personal ACTIVO con un correlativo empezando en
//    1001, en orden de persona_id (antigüedad de registro).
// 3) Deja sembrada una tabla contador (codigo_personal_contador) con el
//    último código usado, para que las altas nuevas sigan el
//    correlativo sin repetirse nunca — ni siquiera si en el futuro se
//    diera de baja a la persona con el código más alto (dar de baja NO
//    resetea el código de aquí en adelante, solo esta limpieza puntual
//    resetea a los que ya estaban inactivos).
import { pool } from '../src/config/db.js';

await pool.query(`ALTER TABLE persona MODIFY estado ENUM('A','I','E') NOT NULL DEFAULT 'A'`);
console.log('1) Columna estado ahora acepta A/I/E.');

const [activos] = await pool.query(
  `SELECT persona_id FROM persona WHERE estado = 'A' ORDER BY persona_id`
);
let codigo = 1000;
for (const p of activos) {
  codigo += 1;
  await pool.query(`UPDATE persona SET codigo_interno = ? WHERE persona_id = ?`, [codigo, p.persona_id]);
}
console.log(`2) ${activos.length} personas activas renumeradas de 1001 a ${codigo}.`);

const [resultadoE] = await pool.query(
  `UPDATE persona SET estado = 'E', codigo_interno = 0 WHERE estado = 'I'`
);
console.log(`3) ${resultadoE.affectedRows} personas Inactivas pasadas a Eliminado (código en 0).`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS codigo_personal_contador (
    id TINYINT NOT NULL PRIMARY KEY,
    ultimo_codigo INT NOT NULL
  )
`);
await pool.query(
  `INSERT INTO codigo_personal_contador (id, ultimo_codigo) VALUES (1, ?)
   ON DUPLICATE KEY UPDATE ultimo_codigo = VALUES(ultimo_codigo)`,
  [codigo]
);
console.log(`4) Contador sembrado en ${codigo}. La próxima persona que se cree tomará ${codigo + 1}.`);

const [resumen] = await pool.query(`SELECT estado, COUNT(*) AS cantidad FROM persona GROUP BY estado`);
console.log('Resumen final por estado:', JSON.stringify(resumen));

await pool.end();
