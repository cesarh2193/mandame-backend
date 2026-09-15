// motorista.licencia era NOT NULL, pero el formulario de Personal deja
// crear un motorista sin llenar "Licencia de conducir" (queda pendiente
// de completar después) — el INSERT ya manda NULL en ese caso
// (personal.routes.js ya hace `licencia || null`), pero la base lo
// rechazaba con "Column 'licencia' cannot be null".
import { pool } from '../src/config/db.js';

await pool.query(`ALTER TABLE motorista MODIFY COLUMN licencia VARCHAR(25) NULL`);
console.log('OK: motorista.licencia ahora permite NULL.');

await pool.end();
