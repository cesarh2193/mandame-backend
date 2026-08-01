import 'dotenv/config';

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Falta la variable de entorno ${name}. Revisa tu archivo .env (usa .env.example como plantilla).`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT || 3000),
  db: {
    host: required('DB_HOST', 'localhost'),
    port: Number(process.env.DB_PORT || 3306),
    database: required('DB_NAME'),
    user: required('DB_USER'),
    password: process.env.DB_PASSWORD || ''
  },
  frontendUrl: required('FRONTEND_URL', 'http://localhost:5173'),
  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: process.env.JWT_EXPIRES_IN || '12h'
  },
  smtp: {
    host: process.env.SMTP_HOST || null,
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || null,
    password: process.env.SMTP_PASSWORD || null,
    from: process.env.SMTP_FROM || 'Mandame <no-responder@mandame.com>'
  }
};
