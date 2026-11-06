/**
 * Tests de la rotación de inventario. Datos 100 % sintéticos.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agregarMovimientos,
  agregarSaldos,
  calcularProducto,
  entradas,
  esComodin,
  movVacio,
  porProveedor,
  salidas,
  sinTraslados,
  TRANSACCIONES,
  TRANSACCIONES_TIPO0,
  type HgiLineaInv,
} from '../lib/hgi/rotacion/mappers';

const l = (tr: string, q: number, o: Partial<HgiLineaInv> = {}): HgiLineaInv => ({
  Id: Math.random(), Fecha: '2026-09-10', CodigoTransaccion: tr, CodigoBodega: '01', CodigoProducto: 'P1',
  NombreProducto: '|PRODUCTO UNO', NitProveedor: '900', NombreProveedor: 'LAB', CantidadDocumento: q, ...o,
});

test('dirección por código, no por signo de la cantidad', () => {
  const { filas } = agregarMovimientos([
    l('40', 10), // compra +
    l('12', -5), // entrada por traslado viene negativa
    l('06', -2), // nota crédito viene negativa
    l('42', 1), // nota crédito POS viene positiva
    l('04', 7), // venta positiva
    l('11', -3), // traslado salida negativo
    l('29', 1), // deterioro viene positivo
    l('05', -1), // devolución a proveedor negativa
  ]);
  const f = filas[0];
  assert.equal(f.ent_compra, 10);
  assert.equal(f.ent_traslado, 5);
  assert.equal(f.ent_devolucion, 3);
  assert.equal(f.sal_venta, 7);
  assert.equal(f.sal_traslado, 3);
  assert.equal(f.sal_otras, 2);
  assert.equal(entradas(f), 18);
  assert.equal(salidas(f), 12);
});

test('correcciones dentro de un documento se netean (traslado −12, −3, +6, −9 = 18)', () => {
  const { filas } = agregarMovimientos([l('12', -12), l('12', -3), l('12', 6), l('12', -9)]);
  assert.equal(filas[0].ent_traslado, 18);
  assert.equal(salidas(filas[0]), 0);
});

test('agrupa por bodega y producto; quita el "|" del nombre; ignora comodines', () => {
  const r = agregarMovimientos([l('40', 1), l('40', 2, { CodigoBodega: '02' }), l('40', 9, { CodigoProducto: '999999992' }), l('40', 1, { CodigoProducto: '0' })]);
  assert.equal(r.filas.length, 2);
  assert.equal(r.productos.get('P1')?.nombre, 'PRODUCTO UNO');
  assert.equal(esComodin('999999980'), false); // "PRODUCTO IVA 19" sí está en el informe de HGI
  assert.equal(esComodin('999999983'), true);
});

test('códigos desconocidos se reportan', () => {
  const r = agregarMovimientos([l('77', 1), l('94', 1)]);
  assert.deepEqual(r.sinMapa, { '77': 1, '94': 1 });
  assert.equal(r.filas.length, 0);
});

test('todo código consultado por tipo 0 está clasificado', () => {
  for (const c of TRANSACCIONES_TIPO0) assert.ok(TRANSACCIONES[c], c);
});

test('agregarSaldos: suma lotes (incluidos negativos) y pondera el costo de los positivos', () => {
  const s = agregarSaldos([
    { CodigoProducto: 'P1', CodigoBodega: '01', Cantidad: 10, Costo: 100 },
    { CodigoProducto: 'P1', CodigoBodega: '01', Cantidad: 30, Costo: 200 },
    { CodigoProducto: 'P1', CodigoBodega: '01', Cantidad: -5, Costo: 0 },
    { CodigoProducto: 'P1', CodigoBodega: '02', Cantidad: 1, Costo: 50 },
  ]);
  const b1 = s.find((x) => x.bodega === '01')!;
  assert.equal(b1.cantidad, 35);
  assert.equal(b1.costo_unitario, 175);
  assert.equal(s.length, 2);
});

const info = { codigo: 'P1', nombre: 'P', nitProveedor: '900', nombreProveedor: 'LAB' };

test('calcularProducto: inicial y final hacia atrás desde la existencia', () => {
  const periodo = { ...movVacio(), ent_compra: 100, sal_venta: 90, ent_devolucion: 10 };
  const posterior = { ...movVacio(), ent_compra: 20, sal_venta: 5 };
  const p = calcularProducto({ info, periodo, posterior, existencia: 45, costoUnitario: 1000 }, 30, 30);
  assert.equal(p.final, 30); // 45 − (20 − 5)
  assert.equal(p.inicial, 10); // 30 − (110 − 90)
  assert.equal(p.diasInventario, 6.7); // (10+30)/2 ÷ 90 × 30
  assert.equal(p.rotacion, 4.5);
  assert.equal(p.ventasNetas, 80);
  assert.equal(p.cobertura, 16.9); // 45 ÷ (80/30)
  assert.equal(p.sugerido, 35); // ceil(2.667×30 − 45)
  assert.equal(p.valorExistencia, 45_000);
  assert.equal(p.estado, 'normal');
});

test('calcularProducto: estados', () => {
  const venta = { ...movVacio(), sal_venta: 30 };
  assert.equal(calcularProducto({ info, periodo: venta, posterior: movVacio(), existencia: 0, costoUnitario: 1 }, 30, 30).estado, 'agotado');
  assert.equal(calcularProducto({ info, periodo: venta, posterior: movVacio(), existencia: 10, costoUnitario: 1 }, 30, 30).estado, 'por_agotarse');
  assert.equal(calcularProducto({ info, periodo: venta, posterior: movVacio(), existencia: 200, costoUnitario: 1 }, 30, 30).estado, 'sobrestock');
  assert.equal(calcularProducto({ info, periodo: movVacio(), posterior: movVacio(), existencia: 5, costoUnitario: 1 }, 30, 30).estado, 'sin_movimiento');
  const sinSal = calcularProducto({ info, periodo: movVacio(), posterior: movVacio(), existencia: 5, costoUnitario: 1 }, 30, 30);
  assert.equal(sinSal.diasInventario, null);
  assert.equal(sinSal.cobertura, null);
  assert.equal(sinSal.sugerido, 0);
});

test('sinTraslados anula sólo los traslados', () => {
  const m = sinTraslados({ ...movVacio(), ent_traslado: 5, sal_traslado: 5, ent_compra: 1 });
  assert.equal(m.ent_traslado + m.sal_traslado, 0);
  assert.equal(m.ent_compra, 1);
});

test('porProveedor: suma y pondera días por costo', () => {
  const a = calcularProducto({ info, periodo: { ...movVacio(), sal_venta: 10 }, posterior: movVacio(), existencia: 10, costoUnitario: 100 }, 30, 30);
  const b = calcularProducto({ info: { ...info, codigo: 'P2' }, periodo: { ...movVacio(), sal_venta: 10 }, posterior: movVacio(), existencia: 40, costoUnitario: 10 }, 30, 30);
  const [p] = porProveedor([a, b], 30);
  assert.equal(p.productos, 2);
  assert.equal(p.valorExistencia, 1400);
  // a: prom 15×100, sal 10×100 ; b: prom 45×10, sal 10×10 → (1500+450)/(1000+100)×30
  assert.equal(p.diasInventario, Math.round(((1500 + 450) / 1100) * 30 * 10) / 10);
});

test('la parte de compras usa la empresa si se entrega (producto que pasó a otra bodega)', () => {
  const periodo = { ...movVacio(), sal_venta: 30 };
  const p = calcularProducto(
    { info, periodo, posterior: movVacio(), existencia: 0, costoUnitario: 10,
      empresa: { periodo: { ...movVacio(), sal_venta: 30 }, existencia: 300, costoUnitario: 10 } },
    30, 30,
  );
  assert.equal(p.existencia, 300);
  assert.equal(p.estado, 'sobrestock'); // en la bodega está en 0, pero la empresa tiene 300 días
  assert.equal(p.sugerido, 0);
  assert.equal(p.salidas, 30); // la rotación sigue siendo de la bodega
});
