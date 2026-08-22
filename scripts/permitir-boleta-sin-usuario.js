import { pool } from '../src/config/db.js';

// Las boletas subidas por el link público (motorista sin cuenta) no
// tienen usuario_id — antes era NOT NULL porque solo se subía con
// sesión iniciada.
const SQL = `ALTER TABLE boleta_motorista MODIFY COLUMN usuario_id INT NULL;`;

const [result] = await pool.query(SQL);
console.log('OK:', result);
await pool.end();
