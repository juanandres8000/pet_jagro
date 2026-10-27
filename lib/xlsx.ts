/**
 * Generador mínimo de .xlsx (Office Open XML) sin dependencias.
 *
 * Por qué propio: el único consumidor es el reporte "PRECIO CERO <LAB>" del módulo
 * de descuentos — texto, números y fechas en una o dos hojas. Una librería de
 * Excel completa sumaría peso al bundle y superficie de cadena de suministro por
 * algo que son ~150 líneas. El ZIP va SIN compresión (método 0, "stored"), que el
 * formato admite y Excel/LibreOffice/Numbers abren sin queja.
 *
 * Seguridad: todo el texto pasa por `esc` (XML) y se escribe como inlineStr, así
 * que ningún valor de HGINet se interpreta como fórmula. Las celdas que empiezan
 * por = + - @ siguen siendo texto: no hay inyección de fórmulas (CSV injection).
 */

export type Celda = string | number | Date | null | undefined;
export interface Hoja {
  nombre: string;
  filas: Celda[][];
  /** Anchos de columna en caracteres (opcional). */
  anchos?: number[];
}

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Caracteres de control que XML 1.0 no admite (salvo tab, LF, CR).
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** Letra de columna Excel (0 → A, 25 → Z, 26 → AA). */
export function columna(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Serial de fecha de Excel (días desde 1899-12-30), sin hora. */
const serialFecha = (d: Date) => Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(1899, 11, 30)) / 86_400_000);

function hojaXml(h: Hoja): string {
  const cols = h.anchos?.length
    ? `<cols>${h.anchos.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const filas = h.filas
    .map((fila, r) => {
      const celdas = fila
        .map((v, c) => {
          if (v === null || v === undefined || v === '') return '';
          const ref = `${columna(c)}${r + 1}`;
          if (v instanceof Date) return `<c r="${ref}" s="1"><v>${serialFecha(v)}</v></c>`;
          if (typeof v === 'number') return Number.isFinite(v) ? `<c r="${ref}"><v>${v}</v></c>` : '';
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${celdas}</row>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `${cols}<sheetData>${filas}</sheetData></worksheet>`
  );
}

/** Nombre de hoja válido para Excel: ≤ 31 caracteres y sin : \ / ? * [ ]. */
export const nombreHoja = (s: string) => s.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31) || 'Hoja';

function archivos(hojas: Hoja[]): Array<[string, string]> {
  const ct =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    hojas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    '</Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';
  const wb =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    hojas.map((h, i) => `<sheet name="${esc(nombreHoja(h.nombre))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    '</sheets></workbook>';
  const wbRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    hojas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${hojas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>';
  // Estilo 1 = fecha dd/mm/yyyy (numFmt 14 es fecha corta según la configuración regional).
  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
    '</styleSheet>';
  return [
    ['[Content_Types].xml', ct],
    ['_rels/.rels', rels],
    ['xl/workbook.xml', wb],
    ['xl/_rels/workbook.xml.rels', wbRels],
    ['xl/styles.xml', styles],
    ...hojas.map((h, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, hojaXml(h)]),
  ];
}

// ------------------------------------------------------------- ZIP stored ---

const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(entradas: Array<[string, string]>): Uint8Array {
  const enc = new TextEncoder();
  const partes: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  // Fecha DOS fija (1980-01-01): el contenido no depende de la hora → salida determinista.
  const DOS_HORA = 0;
  const DOS_FECHA = (0 << 9) | (1 << 5) | 1;

  for (const [nombre, contenido] of entradas) {
    const n = enc.encode(nombre);
    const d = enc.encode(contenido);
    const crc = crc32(d);
    const loc = new DataView(new ArrayBuffer(30));
    loc.setUint32(0, 0x04034b50, true);
    loc.setUint16(4, 20, true);
    loc.setUint16(6, 0x0800, true); // UTF-8 en nombres
    loc.setUint16(8, 0, true); // stored
    loc.setUint16(10, DOS_HORA, true);
    loc.setUint16(12, DOS_FECHA, true);
    loc.setUint32(14, crc, true);
    loc.setUint32(18, d.length, true);
    loc.setUint32(22, d.length, true);
    loc.setUint16(26, n.length, true);
    loc.setUint16(28, 0, true);
    partes.push(new Uint8Array(loc.buffer), n, d);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, DOS_HORA, true);
    cen.setUint16(14, DOS_FECHA, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, d.length, true);
    cen.setUint32(24, d.length, true);
    cen.setUint16(28, n.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), n);
    offset += 30 + n.length + d.length;
  }
  const tamCentral = central.reduce((s, p) => s + p.length, 0);
  const fin = new DataView(new ArrayBuffer(22));
  fin.setUint32(0, 0x06054b50, true);
  fin.setUint16(8, entradas.length, true);
  fin.setUint16(10, entradas.length, true);
  fin.setUint32(12, tamCentral, true);
  fin.setUint32(16, offset, true);
  const todo = [...partes, ...central, new Uint8Array(fin.buffer)];
  const out = new Uint8Array(todo.reduce((s, p) => s + p.length, 0));
  let p = 0;
  for (const t of todo) {
    out.set(t, p);
    p += t.length;
  }
  return out;
}

/** Construye el .xlsx completo. */
export function construirXlsx(hojas: Hoja[]): Uint8Array {
  if (!hojas.length) throw new Error('construirXlsx: al menos una hoja');
  return zip(archivos(hojas));
}
