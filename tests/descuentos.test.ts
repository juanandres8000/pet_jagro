/**
 * Tests del módulo de descuentos (lógica pura: mappers y elección de ventanas).
 *   npm test
 * Datos 100 % sintéticos: ningún NIT, cliente ni documento real.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aLineaDd,
  clasificarCompras,
  clasificarVentas,
  codigoTransaccion,
  esGratisCompra,
  esPrecioCeroVenta,
  reglaPar,
  type HgiDetalleLinea,
} from '../lib/hgi/descuentos/mappers';
import { elegirVentanas, mesAnterior, mesesHasta, ventanaDeMes } from '../lib/hgi/descuentos/refresh';
import type { FilaControlDd } from '../lib/hgi/descuentos/store';

let id = 1000;
const linea = (o: Partial<HgiDetalleLinea>): HgiDetalleLinea => ({
  Id: id++,
  Fecha: '2026-08-10T00:00:00',
  CodigoTransaccion: '04',
  NombreTransaccion: 'FACTURA ELECTRONICA DE VENTA -S.M-',
  NumeroDocumento: 1,
  NitTercero: '111',
  NombreTercero: 'CLIENTE PRUEBA',
  NitProveedor: '900',
  NombreProveedor: 'LAB A',
  CodigoProducto: 'P1',
  NombreProducto: 'PRODUCTO 1',
  CantidadDocumento: 9,
  ValorUnitario: 1000,
  ValorTotalDetalle: 9000,
  ValorDescuentoDetalle: 0,
  CostoUnitario: 700,
  CostoTotal: 6300,
  ...o,
});

test('precio cero: valor 0 con cantidad > 0 en factura', () => {
  assert.equal(esPrecioCeroVenta(linea({ ValorTotalDetalle: 0, CantidadDocumento: 1 })), true);
  assert.equal(esPrecioCeroVenta(linea({ ValorTotalDetalle: '0', CantidadDocumento: '1' })), true);
  assert.equal(esPrecioCeroVenta(linea({})), false);
  assert.equal(esPrecioCeroVenta(linea({ ValorTotalDetalle: 0, CantidadDocumento: 0 })), false);
});

test('precio cero: una nota crédito en valor 0 NO es regalo', () => {
  const nc = linea({ NombreTransaccion: 'NOTA CREDITO FACTURA -SEDE MLLIN-', CodigoTransaccion: '06', ValorTotalDetalle: 0 });
  assert.equal(esPrecioCeroVenta(nc), false);
});

test('clasificarVentas guarda la factura con precio cero completa y nada de las demás', () => {
  const filas = [
    linea({ NumeroDocumento: 1, CantidadDocumento: 9 }),
    linea({ NumeroDocumento: 1, CantidadDocumento: 1, ValorTotalDetalle: 0, CostoTotal: 700 }),
    linea({ NumeroDocumento: 1, NitProveedor: '901', NombreProveedor: 'LAB B', CodigoProducto: 'P2' }),
    linea({ NumeroDocumento: 2 }),
  ];
  const r = clasificarVentas(filas);
  assert.equal(r.docsPrecioCero, 1);
  assert.equal(r.lineas.length, 3);
  assert.deepEqual(r.lineas.map((l) => l.tipo).sort(), ['venta_acompana', 'venta_acompana', 'venta_precio_cero']);
  assert.ok(r.lineas.every((l) => l.documento === 1));
  assert.equal(r.descartadas, 0);
});

test('clasificarVentas: la misma factura en otra transacción es otro documento', () => {
  const filas = [
    linea({ CodigoTransaccion: '04', NumeroDocumento: 5, ValorTotalDetalle: 0, CantidadDocumento: 1 }),
    linea({ CodigoTransaccion: '50', NumeroDocumento: 5 }),
  ];
  const r = clasificarVentas(filas);
  assert.equal(r.lineas.length, 1);
  assert.equal(r.lineas[0].codigo_transaccion, '04');
});

test('agregado por mes y laboratorio: venta, descuento, costo y precio cero', () => {
  const filas = [
    linea({ ValorTotalDetalle: 9000, ValorDescuentoDetalle: 450, CostoTotal: 6300 }),
    linea({ ValorTotalDetalle: 0, CantidadDocumento: 1, ValorUnitario: 1000, CostoTotal: 700 }),
    // Nota crédito: venta en negativo y costo en positivo → el costo debe restar.
    linea({
      CodigoTransaccion: '06',
      NombreTransaccion: 'NOTA CREDITO FACTURA -SEDE MLLIN-',
      ValorTotalDetalle: -2000,
      ValorDescuentoDetalle: -100,
      CantidadDocumento: -2,
      CostoTotal: 1400,
    }),
  ];
  const r = clasificarVentas(filas);
  assert.equal(r.agregados.length, 1);
  const a = r.agregados[0];
  assert.equal(a.mes, '2026-08');
  assert.equal(a.nit_proveedor, '900');
  assert.equal(a.venta_bruta, 7000);
  assert.equal(a.descuento, 350);
  assert.equal(a.costo, 6300 + 700 - 1400);
  assert.equal(a.costo_precio_cero, 700);
  assert.equal(a.lista_precio_cero, 1000);
  assert.equal(a.unidades_precio_cero, 1);
  assert.equal(a.lineas, 3);
});

test('agregado redondea a centavos (sin basura de coma flotante)', () => {
  const filas = [linea({ ValorTotalDetalle: 0.1 }), linea({ ValorTotalDetalle: 0.2 })];
  assert.equal(clasificarVentas(filas).agregados[0].venta_bruta, 0.3);
});

test('aLineaDd rechaza filas sin Id, fecha o documento', () => {
  assert.equal(aLineaDd(linea({ Id: undefined }), 'venta', 'venta_precio_cero'), null);
  assert.equal(aLineaDd(linea({ Fecha: '' }), 'venta', 'venta_precio_cero'), null);
  assert.equal(aLineaDd(linea({ NumeroDocumento: undefined }), 'venta', 'venta_precio_cero'), null);
  const ok = aLineaDd(linea({ CodigoTransaccion: 4 }), 'venta', 'venta_acompana');
  assert.equal(ok?.codigo_transaccion, '04');
  assert.equal(ok?.mes, '2026-08');
});

test('clasificarVentas cuenta como descartada una línea con precio cero sin Id', () => {
  const r = clasificarVentas([linea({ Id: undefined, ValorTotalDetalle: 0, CantidadDocumento: 1 })]);
  assert.equal(r.descartadas, 1);
});

test('codigoTransaccion normaliza a 2 dígitos', () => {
  assert.equal(codigoTransaccion(4), '04');
  assert.equal(codigoTransaccion('43'), '43');
  assert.equal(codigoTransaccion(' 5 '), '05');
});

test('compras: gratis = valor 0, o descuento ≥ valor', () => {
  assert.equal(esGratisCompra(linea({ ValorTotalDetalle: 0, CantidadDocumento: 1 })), true);
  assert.equal(esGratisCompra(linea({ ValorTotalDetalle: 5000, ValorDescuentoDetalle: 5000 })), true);
  assert.equal(esGratisCompra(linea({ ValorTotalDetalle: 5000, ValorDescuentoDetalle: 500 })), false);
  assert.equal(esGratisCompra(linea({ ValorTotalDetalle: 0, CantidadDocumento: -1 })), false);
});

test('clasificarCompras asigna tipos por transacción y descarta lo que no es de ella', () => {
  const filas = [
    linea({ CodigoTransaccion: '40', ValorTotalDetalle: 10000 }),
    linea({ CodigoTransaccion: '40', ValorTotalDetalle: 0, CantidadDocumento: 1 }),
    linea({ CodigoTransaccion: '45', ValorTotalDetalle: 0, CantidadDocumento: 1 }),
  ];
  const r40 = clasificarCompras(filas, '40');
  assert.deepEqual(r40.lineas.map((l) => l.tipo), ['compra', 'compra_gratis']);
  assert.equal(r40.descartadas, 1);
  assert.ok(r40.lineas.every((l) => l.fuente === 'compra'));
  const r33 = clasificarCompras([linea({ CodigoTransaccion: '33', ValorTotalDetalle: 0 })], '33');
  assert.equal(r33.lineas[0].tipo, 'entrada_bonificado');
  assert.throws(() => clasificarCompras([], '99'));
});

test('reglaPar', () => {
  assert.equal(reglaPar(9, 1), '9+1');
  assert.equal(reglaPar(0, 1), null);
});

test('ventanaDeMes y mesesHasta', () => {
  assert.deepEqual(ventanaDeMes('2028-02'), { desde: '2028-02-01', hasta: '2028-02-29' });
  assert.deepEqual(ventanaDeMes('2026-09'), { desde: '2026-09-01', hasta: '2026-09-30' });
  assert.deepEqual(mesesHasta('2026-03-05', '2025-11'), ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03']);
  assert.equal(mesAnterior('2026-01'), '2025-12');
});

const ctl = (mes: string, o: Partial<FilaControlDd> = {}): FilaControlDd => ({
  desde: `${mes}-01`,
  hasta: ventanaDeMes(mes).hasta,
  estado: 'ok',
  intentos: 0,
  actualizadoEn: new Date('2026-10-27T00:00:00Z'),
  lineasVenta: 1,
  lineasGuardadas: 1,
  lineasCompra: 1,
  docsPrecioCero: 1,
  ultimoError: null,
  okEn: new Date('2026-10-27T00:00:00Z'),
  ...o,
});

test('elegirVentanas: sin control, primero el mes en curso y luego del más nuevo al más viejo', () => {
  const r = elegirVentanas([], '2026-03-20', Date.parse('2026-03-20T12:00:00Z'));
  assert.deepEqual(r.map((x) => x.mes), ['2026-03', '2026-02', '2026-01']);
});

test('elegirVentanas: el mes anterior sigue vivo hasta el día 15', () => {
  const ahora = Date.parse('2026-10-10T12:00:00Z');
  const viejo = new Date(ahora - 7 * 3_600_000);
  const control = [ctl('2026-09', { okEn: viejo }), ctl('2026-10', { okEn: viejo })];
  const r = elegirVentanas(control, '2026-10-10', ahora).map((x) => x.mes);
  assert.deepEqual(r.slice(0, 2), ['2026-10', '2026-09']);
  const r2 = elegirVentanas(control, '2026-10-20', Date.parse('2026-10-20T12:00:00Z')).map((x) => x.mes);
  assert.ok(!r2.includes('2026-09'));
});

test('elegirVentanas: un mes vivo refrescado hace poco no se repite', () => {
  const ahora = Date.parse('2026-10-27T12:00:00Z');
  const control = mesesHasta('2026-10-27').map((m) => ctl(m, { okEn: new Date(ahora - 3_600_000) }));
  assert.deepEqual(elegirVentanas(control, '2026-10-27', ahora), []);
});

test('elegirVentanas: los meses nunca ingestados van antes que los reintentos', () => {
  const ahora = Date.parse('2026-10-27T12:00:00Z');
  const control = mesesHasta('2026-10-27').map((m) => ctl(m, { okEn: new Date(ahora - 3_600_000) }));
  control[2] = ctl('2026-03', { estado: 'error', intentos: 1, okEn: null, actualizadoEn: new Date(ahora - 3_600_000) });
  control.splice(1, 1); // 2026-02 sin fila: nunca ingestado
  const r = elegirVentanas(control, '2026-10-27', ahora);
  assert.deepEqual(r.map((x) => x.mes), ['2026-02', '2026-03']);
  assert.match(r[1].motivo, /reintento 2\/3/);
});

test('elegirVentanas: una ventana agotada descansa y luego vuelve (no se abandona)', () => {
  const ahora = Date.parse('2026-10-27T12:00:00Z');
  const base = mesesHasta('2026-10-27').map((m) => ctl(m, { okEn: new Date(ahora - 3_600_000) }));
  const reciente = [...base];
  reciente[3] = ctl('2026-04', { estado: 'error', intentos: 3, okEn: null, actualizadoEn: new Date(ahora - 3_600_000) });
  assert.deepEqual(elegirVentanas(reciente, '2026-10-27', ahora), []);
  const vieja = [...base];
  vieja[3] = ctl('2026-04', { estado: 'error', intentos: 3, okEn: null, actualizadoEn: new Date(ahora - 7 * 3_600_000) });
  const r = elegirVentanas(vieja, '2026-10-27', ahora);
  assert.deepEqual(r.map((x) => x.mes), ['2026-04']);
  assert.match(r[0].motivo, /enfriamiento/);
});

test('elegirVentanas: una ventana que quedó pendiente (lambda muerto) cuenta como fallida', () => {
  const ahora = Date.parse('2026-10-27T12:00:00Z');
  const control = mesesHasta('2026-10-27').map((m) => ctl(m, { okEn: new Date(ahora - 3_600_000) }));
  // Muerta hace 2 h, nunca terminó: se reintenta, pero DESPUÉS de lo nunca ingestado.
  control[7] = ctl('2026-08', { estado: 'pendiente', intentos: 1, okEn: null, actualizadoEn: new Date(ahora - 2 * 3_600_000) });
  assert.deepEqual(elegirVentanas(control, '2026-10-27', ahora).map((x) => x.mes), ['2026-08']);
  // Pendiente de hace 2 min: puede estar corriendo en otra invocación, no se toca.
  control[7] = ctl('2026-08', { estado: 'pendiente', intentos: 1, okEn: null, actualizadoEn: new Date(ahora - 120_000) });
  assert.deepEqual(elegirVentanas(control, '2026-10-27', ahora), []);
  // Pendiente 3 veces seguidas (muere siempre): enfriamiento, no bucle.
  control[7] = ctl('2026-08', { estado: 'pendiente', intentos: 3, okEn: null, actualizadoEn: new Date(ahora - 3_600_000) });
  assert.deepEqual(elegirVentanas(control, '2026-10-27', ahora), []);
});

test('elegirVentanas: un mes vivo con error reciente agotado no se reintenta en bucle', () => {
  const ahora = Date.parse('2026-10-27T12:00:00Z');
  const control = mesesHasta('2026-10-27').map((m) => ctl(m, { okEn: new Date(ahora - 3_600_000) }));
  control[9] = ctl('2026-10', { estado: 'error', intentos: 3, okEn: new Date(ahora - 10 * 3_600_000), actualizadoEn: new Date(ahora - 600_000) });
  assert.deepEqual(elegirVentanas(control, '2026-10-27', ahora), []);
});
