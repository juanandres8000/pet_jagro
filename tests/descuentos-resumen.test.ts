/**
 * Tests de cálculos del módulo de descuentos y del generador .xlsx.
 * Datos 100 % sintéticos.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import {
  agruparPorFactura,
  bonificadoPorProducto,
  hojasReporte,
  nombreArchivo,
  ordenarLabs,
  resumirLab,
  totalizar,
} from '../lib/hgi/descuentos/resumen';
import type { FilaLab, LineaReporte } from '../lib/hgi/descuentos/store';
import { columna, construirXlsx, crc32, nombreHoja } from '../lib/xlsx';

void inflateRawSync; // el zip va sin compresión: se lee directo

const lab = (o: Partial<FilaLab>): FilaLab => ({
  nit: '900', nombre: 'LAB A', ventaBruta: 1_000_000, descuento: 50_000, costo: 800_000,
  costoPrecioCero: 100_000, listaPrecioCero: 130_000, unidadesPrecioCero: 10,
  gratisCompra: 0, unidadesGratisCompra: 0, entradaBonificado: 0, descuentoFacturaCompra: 0, descuentoAlPagar: 0,
  ...o,
});

test('resumirLab: margen con y sin precio cero', () => {
  const r = resumirLab(lab({}));
  assert.equal(r.ventaNeta, 950_000);
  assert.equal(r.margen, 150_000);
  assert.ok(Math.abs((r.margenPct ?? 0) - 150_000 / 950_000) < 1e-12);
  assert.ok(Math.abs((r.margenSinPrecioCeroPct ?? 0) - 250_000 / 950_000) < 1e-12);
  assert.ok(Math.abs((r.precioCero.pctVenta ?? 0) - 100_000 / 950_000) < 1e-12);
});

test('resumirLab: estados de cobertura', () => {
  assert.equal(resumirLab(lab({ costoPrecioCero: 0 })).estado, 'sin_precio_cero');
  assert.equal(resumirLab(lab({})).estado, 'sin_compensacion');
  const parcial = resumirLab(lab({ gratisCompra: 40_000 }));
  assert.equal(parcial.estado, 'parcial');
  assert.equal(parcial.brecha, 60_000);
  const cubierto = resumirLab(lab({ gratisCompra: 60_000, entradaBonificado: 10_000, descuentoFacturaCompra: 26_000 }));
  assert.equal(cubierto.estado, 'cubierto');
  assert.equal(cubierto.brecha, 4_000);
  assert.equal(cubierto.recibidoMercancia, 70_000);
});

test('resumirLab: un débito neto a 14352290 no resta compensación', () => {
  const r = resumirLab(lab({ descuentoAlPagar: -5_000 }));
  assert.equal(r.compensacionObservada, 0);
  assert.equal(r.descuentoAlPagar, -5_000);
});

test('resumirLab: laboratorio sin venta no divide por cero', () => {
  const r = resumirLab(lab({ ventaBruta: 0, descuento: 0, costo: 0, costoPrecioCero: 0, descuentoAlPagar: 10 }));
  assert.equal(r.margenPct, null);
  assert.equal(r.precioCero.pctVenta, null);
  assert.equal(r.cobertura, null);
});

test('totalizar y ordenarLabs', () => {
  const labs = ordenarLabs([resumirLab(lab({ nit: '1', nombre: 'B', costoPrecioCero: 10 })), resumirLab(lab({ nit: '2', nombre: 'A' }))]);
  assert.deepEqual(labs.map((l) => l.nit), ['2', '1']);
  const t = totalizar(labs);
  assert.equal(t.ventaNeta, 1_900_000);
  assert.equal(t.precioCeroCosto, 100_010);
  assert.equal(t.labsConPrecioCero, 2);
  assert.equal(t.labsConBrecha, 2);
  assert.equal(totalizar([]).margenPct, null);
});

const lr = (o: Partial<LineaReporte>): LineaReporte => ({
  codigoTransaccion: '04', documento: 10, fecha: '2026-08-20', codigoProducto: 'P1', producto: 'VACUNA X',
  cantidad: 9, precioCero: false, valorUnitario: 1000, costoTotal: 6300, cliente: 'CLIENTE PRUEBA', ...o,
});

test('agruparPorFactura y bonificadoPorProducto', () => {
  const lineas = [
    lr({}), lr({ cantidad: 1, precioCero: true, costoTotal: 700 }),
    lr({ documento: 11, codigoProducto: 'P2', producto: 'JARABE Y', cantidad: 2, precioCero: true, costoTotal: 900, valorUnitario: 600 }),
    lr({ documento: 12, cantidad: 3, precioCero: true, costoTotal: 2100 }),
  ];
  const b = agruparPorFactura(lineas);
  assert.equal(b.length, 3);
  assert.equal(b[0].lineas.length, 2);
  const res = bonificadoPorProducto(b);
  assert.deepEqual(res.map((r) => [r.producto, r.unidades, r.costo]), [['VACUNA X', 4, 2800], ['JARABE Y', 2, 900]]);
});

test('hojasReporte replica el formato del Excel manual', () => {
  const hojas = hojasReporte({ nit: '900', nombre: 'LAB A' }, '2026-08-16', '2026-08-31', [
    lr({}), lr({ cantidad: 1, precioCero: true, costoTotal: 700 }),
  ]);
  const f = hojas[0].filas;
  assert.equal(f[0][2], 'JOTAGRO DISTRIBUCIONES ESPECIALIZADAS S.A.S.');
  assert.equal(f[3][2], 'ENTRE 2026-08-16 Y 2026-08-31');
  assert.deepEqual(f[4], ['TR', 'DOCUMEN', 'FECHA', 'CANTIDAD', 'TIPO', 'PRODUCTO', 'BONIFICADO']);
  assert.equal(f[5][0], '04');
  assert.equal(f[5][1], 10);
  assert.ok(f[5][2] instanceof Date);
  assert.deepEqual(f[5].slice(5), ['VACUNA X', 1]); // resumen F–G desde la primera fila
  assert.deepEqual(f[6].slice(0, 5), ['P1', null, 'VACUNA X', 9, 'PAGADO']);
  assert.deepEqual(f[7].slice(0, 5), ['P1', null, 'VACUNA X', 1, 'PRECIO CERO']);
  const total = f[f.length - 1];
  assert.equal(total[3], 1); // facturas
  assert.equal(total[6], 1); // unidades bonificadas
  const det = hojas[1].filas;
  assert.equal(det[2][9], 1000); // valor lista de la línea regalada
  assert.equal(det[1][9], null); // la pagada no lleva valor lista
});

test('hojasReporte advierte cuando el periodo tiene meses sin datos', () => {
  const sin = hojasReporte({ nit: '900', nombre: 'LAB A' }, '2026-07-01', '2026-08-31', [lr({})], ['2026-07']);
  assert.equal(sin[0].filas[0][5], 'ADVERTENCIA: REPORTE INCOMPLETO, SIN DATOS PARA 2026-07');
  assert.equal(sin[1].filas[0][0], 'ADVERTENCIA: REPORTE INCOMPLETO, SIN DATOS PARA 2026-07');
  const con = hojasReporte({ nit: '900', nombre: 'LAB A' }, '2026-08-01', '2026-08-31', [lr({})]);
  assert.equal(con[0].filas[0][5], null);
  assert.equal(con[1].filas[0][0], 'TR');
});

test('nombreArchivo limpia caracteres peligrosos', () => {
  assert.equal(nombreArchivo('Compañía "X"/../\r\n', '2026-09-01', '2026-09-30'), 'PRECIO CERO Compania X.. 2026-09-01 a 2026-09-30.xlsx');
  assert.equal(nombreArchivo('', '2026-09-01', '2026-09-30'), 'PRECIO CERO LABORATORIO 2026-09-01 a 2026-09-30.xlsx');
});

test('xlsx: crc32 con el vector estándar', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('xlsx: columnas y nombre de hoja', () => {
  assert.equal(columna(0), 'A');
  assert.equal(columna(25), 'Z');
  assert.equal(columna(26), 'AA');
  assert.equal(columna(701), 'ZZ');
  assert.equal(nombreHoja('a/b:c*d?[e]'.repeat(5)).length, 31);
});

/** Lee las entradas de un zip "stored" (lo que genera construirXlsx). */
function leerZip(buf: Uint8Array): Map<string, string> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Map<string, string>();
  let p = 0;
  while (dv.getUint32(p, true) === 0x04034b50) {
    assert.equal(dv.getUint16(p + 8, true), 0);
    const tam = dv.getUint32(p + 18, true);
    const crc = dv.getUint32(p + 14, true);
    const ln = dv.getUint16(p + 26, true);
    const nombre = new TextDecoder().decode(buf.subarray(p + 30, p + 30 + ln));
    const datos = buf.subarray(p + 30 + ln, p + 30 + ln + tam);
    assert.equal(crc32(datos), crc, `crc de ${nombre}`);
    out.set(nombre, new TextDecoder().decode(datos));
    p += 30 + ln + tam;
  }
  return out;
}

test('xlsx: estructura válida, texto escapado y sin fórmulas', () => {
  const buf = construirXlsx([{ nombre: 'Hoja', filas: [['=HYPERLINK("x")', '<b>&', 12.5, new Date('2026-08-24T00:00:00Z'), null]] }]);
  const z = leerZip(buf);
  assert.deepEqual([...z.keys()].sort(), [
    '[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml',
  ]);
  const hoja = z.get('xl/worksheets/sheet1.xml')!;
  assert.ok(!hoja.includes('<f>'), 'nunca escribe fórmulas');
  assert.ok(hoja.includes('t="inlineStr"><is><t xml:space="preserve">=HYPERLINK(&quot;x&quot;)</t>'));
  assert.ok(hoja.includes('&lt;b&gt;&amp;'));
  assert.ok(hoja.includes('<c r="C1"><v>12.5</v></c>'));
  assert.ok(hoja.includes('<c r="D1" s="1"><v>46258</v></c>')); // 2026-08-24
  assert.ok(!hoja.includes('E1'));
  // Determinista: mismo contenido, mismos bytes.
  assert.deepEqual(construirXlsx([{ nombre: 'Hoja', filas: [['a']] }]), construirXlsx([{ nombre: 'Hoja', filas: [['a']] }]));
  assert.throws(() => construirXlsx([]));
});
