import PDFDocument from 'pdfkit';

// Arma el PDF que se adjunta al correo de "CAD finalizado": motorista,
// entrada, salida, tiempo trabajado y repartos del día completo.
export function generarPDFCierreCad(filas, sucursalNombre, fecha) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'LETTER' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const anchoUtil = doc.page.width - 80;

    doc.font('Helvetica-Bold').fontSize(16).text(`Cierre del día — ${sucursalNombre}`);
    doc.font('Helvetica').fontSize(10).fillColor('#5B6270').text(`Fecha: ${fecha}`);
    doc.moveDown(1);
    doc.fillColor('#000');

    const columnas = [
      { titulo: 'MOTORISTA', ancho: 0.34 },
      { titulo: 'ENTRADA', ancho: 0.16 },
      { titulo: 'SALIDA', ancho: 0.16 },
      { titulo: 'TIEMPO', ancho: 0.16 },
      { titulo: 'REPARTOS', ancho: 0.18 }
    ].map((c) => ({ ...c, ancho: c.ancho * anchoUtil }));

    let y = doc.y;

    function encabezadoTabla() {
      let x = 40;
      columnas.forEach((col) => {
        doc.rect(x, y, col.ancho, 22).fillAndStroke('#EAEAEA', '#000000');
        doc.fillColor('#000').font('Helvetica-Bold').fontSize(9)
          .text(col.titulo, x + 4, y + 7, { width: col.ancho - 8 });
        x += col.ancho;
      });
      y += 22;
    }

    function saltoDePaginaSiNecesario() {
      if (y + 20 > doc.page.height - 50) {
        doc.addPage();
        y = 40;
        encabezadoTabla();
      }
    }

    encabezadoTabla();

    if (filas.length === 0) {
      doc.font('Helvetica').fontSize(10).text('No hubo motoristas con cierre autorizado hoy.', 40, y + 10);
    }

    filas.forEach((fila) => {
      saltoDePaginaSiNecesario();
      const horas = fila.minutosTrabajados != null ? (fila.minutosTrabajados / 60).toFixed(1) : '—';
      const valores = [
        fila.nombre || '',
        fila.horaIngreso || '—',
        fila.horaSalida || '—',
        horas,
        String(fila.cantidadRepartos ?? 0)
      ];

      let x = 40;
      valores.forEach((valor, idx) => {
        doc.rect(x, y, columnas[idx].ancho, 20).strokeColor('#DDDDDD').stroke();
        doc.font('Helvetica').fontSize(9).fillColor('#000').text(valor, x + 4, y + 5, { width: columnas[idx].ancho - 8 });
        x += columnas[idx].ancho;
      });
      y += 20;
    });

    doc.end();
  });
}
