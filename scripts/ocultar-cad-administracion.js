// El CAD "ADMINISTRACION" (sucursal_id 1) no es un centro de despacho
// real — se usa solo para agrupar administrativamente a algunas personas
// y a un puñado de cuentas de Digitador sin CAD real. Debía dejar de
// aparecer en todos los selectores operativos (Asignaciones, Cierre de
// turno, Boletas, Informes, Hoy, Planificación, Monitoreo, Usuarios y
// permisos, Editar personal) SIN marcarse inactiva (las personas ya
// asignadas ahí no deben verse afectadas) y sin desaparecer del catálogo
// "Empresas y sucursales", donde un Admin la sigue viendo para gestionarla.
//
// Por eso es una columna aparte de `estado`: `visible_operativa` decide
// si aparece en los SELECTORES; `estado` sigue significando lo de
// siempre (activa/inactiva). Los queries que arman listas de CAD para
// elegir uno (auth.routes.js, empresas.routes.js, dashboard.routes.js,
// monitoreo.routes.js) ahora filtran por las dos.
import { pool } from '../src/config/db.js';

await pool.query(`ALTER TABLE sucursal ADD COLUMN visible_operativa TINYINT(1) NOT NULL DEFAULT 1`);
console.log('Columna visible_operativa agregada.');

const [resultado] = await pool.query(
  `UPDATE sucursal SET visible_operativa = 0 WHERE TRIM(nombre) = 'ADMINISTRACION'`
);
console.log('Filas actualizadas (debería ser 1 - ADMINISTRACION):', resultado.affectedRows);

const [verificacion] = await pool.query(
  `SELECT sucursal_id, nombre, estado, visible_operativa FROM sucursal WHERE TRIM(nombre) = 'ADMINISTRACION'`
);
console.log(JSON.stringify(verificacion, null, 2));

await pool.end();
