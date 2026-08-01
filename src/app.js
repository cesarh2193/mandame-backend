import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';

import authRoutes from './routes/auth.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import planificacionRoutes from './routes/planificacion.routes.js';
import asignacionesRoutes from './routes/asignaciones.routes.js';
import asistenciaRoutes from './routes/asistencia.routes.js';
import cierreTurnoRoutes from './routes/cierreTurno.routes.js';
import autorizacionRoutes from './routes/autorizacion.routes.js';
import monitoreoRoutes from './routes/monitoreo.routes.js';
import { empresasRouter, sucursalesRouter } from './routes/empresas.routes.js';
import tarifasRoutes from './routes/tarifas.routes.js';
import personalRoutes from './routes/personal.routes.js';
import usuariosRoutes from './routes/usuarios.routes.js';
import informesRoutes from './routes/informes.routes.js';

export const app = express();

app.use(cors({ origin: env.frontendUrl }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/planificacion', planificacionRoutes);
app.use('/api/asignaciones', asignacionesRoutes);
app.use('/api/asistencia', asistenciaRoutes);
app.use('/api/cierre-turno', cierreTurnoRoutes);
app.use('/api/autorizacion', autorizacionRoutes);
app.use('/api/monitoreo', monitoreoRoutes);
app.use('/api/empresas', empresasRouter);
app.use('/api/sucursales', sucursalesRouter);
app.use('/api/tarifas', tarifasRoutes);
app.use('/api/personal', personalRoutes);
app.use('/api/usuarios', usuariosRoutes);
app.use('/api/informes', informesRoutes);

app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
app.use(errorHandler);
