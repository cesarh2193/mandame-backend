// Documentos que se pueden adjuntar al expediente de una persona
// (Catálogos > Personal). `tipo` es el valor que se guarda en
// persona_documento.tipo y con el que se arma la ruta de subida
// (/api/personal/:id/documentos/:tipo) — no cambiar los ya existentes
// (DPI, RECIBO_LUZ, LICENCIA) sin migrar los archivos ya subidos, porque
// quedarían huérfanos (el archivo en disco seguiría existiendo pero ya
// no habría ningún tipo que apunte a él).
export const TIPOS_DOCUMENTO_PERSONAL = [
  { tipo: 'DPI', etiqueta: 'DPI (frente)', categoria: 'Identificación' },
  { tipo: 'DPI_REVERSO', etiqueta: 'DPI (reverso)', categoria: 'Identificación' },
  { tipo: 'LICENCIA', etiqueta: 'Licencia de conducir (frente)', categoria: 'Identificación' },
  { tipo: 'LICENCIA_REVERSO', etiqueta: 'Licencia de conducir (reverso)', categoria: 'Identificación' },
  { tipo: 'RECIBO_LUZ', etiqueta: 'Recibo de luz', categoria: 'Identificación' },
  { tipo: 'TARJETA_CIRCULACION', etiqueta: 'Tarjeta de circulación', categoria: 'Administrativo' },
  { tipo: 'POLITICAS_CUMPLIMIENTO', etiqueta: 'Políticas de cumplimiento', categoria: 'Administrativo' },
  { tipo: 'ENTREVISTA', etiqueta: 'Entrevista', categoria: 'Administrativo' },
  { tipo: 'TARJETA_SALUD', etiqueta: 'Tarjeta de salud', categoria: 'Salud' },
  { tipo: 'TARJETA_PULMONES', etiqueta: 'Tarjeta de pulmones', categoria: 'Salud' },
  { tipo: 'MANIPULACION_ALIMENTOS', etiqueta: 'Tarjeta de manipulación de alimentos (frente)', categoria: 'Salud' },
  { tipo: 'MANIPULACION_ALIMENTOS_REVERSO', etiqueta: 'Tarjeta de manipulación de alimentos (reverso)', categoria: 'Salud' }
];

export const CATEGORIAS_DOCUMENTO_PERSONAL = ['Identificación', 'Administrativo', 'Salud'];
