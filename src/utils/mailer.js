import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

let transporter = null;
if (env.smtp.host) {
  transporter = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.port === 465,
    auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.password } : undefined
  });
}

/**
 * Envía el resumen de cierre a un gerente. Si no hay SMTP
 * configurado (.env vacío en SMTP_HOST), no falla: solo lo
 * imprime en consola, para poder probar todo el flujo de
 * autorización en desarrollo sin tener un correo real conectado.
 */
export async function enviarResumenGerente({ para, sucursalNombre, fecha, resumen }) {
  const asunto = `Resumen de cierre — ${sucursalNombre} — ${fecha}`;
  const cuerpo = `
    <p>Se autorizó el cierre del día en <strong>${sucursalNombre}</strong>.</p>
    <ul>
      <li>Motoristas planificados: ${resumen.motoristasPlan}</li>
      <li>Motoristas que llegaron: ${resumen.motoristasAsistieron}</li>
      <li>Entregas totales: ${resumen.entregasTotal}</li>
      <li>% de cumplimiento: ${resumen.porcentaje}%</li>
    </ul>
    <p style="color:#8B92A0;font-size:12px;">Mandame — correo automático, no responder.</p>
  `;

  if (!transporter) {
    console.log('[correo simulado — configura SMTP_HOST en .env para enviarlo de verdad]');
    console.log(`Para: ${para}\nAsunto: ${asunto}\n${cuerpo.replace(/<[^>]+>/g, '')}`);
    return { simulado: true };
  }

  await transporter.sendMail({
    from: env.smtp.from,
    to: para,
    subject: asunto,
    html: cuerpo
  });
  return { simulado: false };
}
