import fs from 'node:fs';
import path from 'node:path';

// Un log por día (uploads/logs quedaría raro; esto va aparte de uploads/)
// para poder revisarlos entrando al servidor sin depender de que alguien
// haya dejado la terminal abierta con la consola a la vista — importante
// ahora que el sistema lo usan varias personas a la vez y un error se
// puede perder si nadie estaba mirando en ese momento.
const LOGS_DIR = path.resolve(process.cwd(), 'logs');
fs.mkdirSync(LOGS_DIR, { recursive: true });

function archivoDeHoy() {
  return path.join(LOGS_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
}

function registrar(nivel, mensaje, extra) {
  const linea = JSON.stringify({ fecha: new Date().toISOString(), nivel, mensaje, ...extra });
  fs.appendFile(archivoDeHoy(), linea + '\n', (err) => {
    if (err) console.error('No se pudo escribir el log:', err.message);
  });
}

export const logger = {
  error(mensaje, extra = {}) {
    console.error(mensaje, extra);
    registrar('ERROR', mensaje, extra);
  },
  warn(mensaje, extra = {}) {
    console.warn(mensaje, extra);
    registrar('WARN', mensaje, extra);
  }
};
