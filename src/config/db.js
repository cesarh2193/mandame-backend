import mysql from 'mysql2/promise';
import { env } from './env.js';

// Un solo pool para toda la app. mysql2 en modo promesa permite
// await pool.query(...) directo, y soporta CALL para los
// procedimientos almacenados (sp_cerrar_turno, sp_autorizar_repartos,
// etc. — ver mandame_procedimientos.sql).
export const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  database: env.db.database,
  user: env.db.user,
  password: env.db.password,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true, // evita líos de zona horaria con DATE/DATETIME al leerlos en JS
  charset: 'utf8mb4' // explícito: no depender del locale del sistema operativo donde corra el backend
});

/**
 * Llama un procedimiento almacenado y devuelve su primer result set.
 * Los procedimientos que solo hacen INSERT/UPDATE no devuelven filas
 * (rows[0] queda vacío), y eso está bien.
 */
export async function callProcedure(nombre, params = []) {
  const placeholders = params.map(() => '?').join(',');
  const [rows] = await pool.query(`CALL ${nombre}(${placeholders})`, params);
  // mysql2 devuelve un array de result sets para CALL; el último
  // elemento es siempre el resumen de OK packets, así que tomamos
  // el primero como los datos reales (si el procedimiento no
  // devuelve nada, rows[0] es un OK packet igual, no una lista).
  return Array.isArray(rows[0]) ? rows[0] : [];
}
