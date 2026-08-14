import { pool } from '../src/config/db.js';

const SQL = `
CREATE TABLE IF NOT EXISTS boleta_motorista (
  boleta_id INT AUTO_INCREMENT PRIMARY KEY,
  motorista_id INT NOT NULL,
  sucursal_id INT NOT NULL,
  fecha DATE NOT NULL,
  archivo_local VARCHAR(255) NOT NULL,
  drive_file_id VARCHAR(128) NULL,
  drive_web_link VARCHAR(500) NULL,
  usuario_id INT NOT NULL,
  creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_boleta_motorista_fecha (motorista_id, fecha)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

const [result] = await pool.query(SQL);
console.log('OK:', result);
await pool.end();
