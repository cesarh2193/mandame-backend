import { app } from './app.js';
import { env } from './config/env.js';
import { pool } from './config/db.js';

async function start() {
  try {
    await pool.query('SELECT 1');
    console.log(`Conectado a la base de datos "${env.db.database}" en ${env.db.host}.`);
  } catch (err) {
    console.error('No se pudo conectar a la base de datos. Revisa tu archivo .env.');
    console.error(err.message);
    process.exit(1);
  }

  app.listen(env.port, () => {
    console.log(`Mandame backend escuchando en http://localhost:${env.port}`);
  });
}

start();
