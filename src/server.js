import { app } from './app.js';
import { env } from './config/env.js';
import { pool } from './config/db.js';
import { logger } from './utils/logger.js';

// Estos dos son la red de seguridad final: cualquier error que se escape
// de un handler async sin pasar por errorHandler.js (ej. un throw dentro
// de un callback, o una promesa sin .catch) igual queda guardado en
// /logs en vez de perderse solo en la terminal.
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException: ' + err.message, { stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection: ' + (reason?.message || String(reason)), { stack: reason?.stack });
});

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
