import { pool } from '../src/config/db.js';

// Se agregaron tipos de documento más largos (ej. MANIPULACION_ALIMENTOS_REVERSO,
// 31 caracteres) a persona_documento.tipo — este script ensancha la columna
// para que quepan. Ensanchar un VARCHAR es seguro: no toca los datos existentes.
const SQL = `ALTER TABLE persona_documento MODIFY COLUMN tipo VARCHAR(40) NOT NULL;`;

const [result] = await pool.query(SQL);
console.log('OK:', result);
await pool.end();
