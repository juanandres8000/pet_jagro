/**
 * Tests de los pagos confirmados del precio cero. Datos 100 % sintéticos.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claveFactura, confirmadoPorLab, estadoFactura, validarPago, type FacturaP0 } from '../lib/hgi/descuentos/pagos';
import { puedeRegistrarPagos, registradores } from '../lib/hgi/descuentos/permisos';

const fac = (o: Partial<FacturaP0>): FacturaP0 => ({
  nit: '900111', codigoTransaccion: '01', documento: 1, fecha: '2026-09-10', cliente: 'CLIENTE X',
  costo: 100_000, lista: 140_000, unidades: 2, ...o,
});

test('estadoFactura: pendiente, parcial, pagada y saldada', () => {
  assert.deepEqual(estadoFactura(100_000, undefined), { pagado: 0, saldo: 100_000, estado: 'pendiente' });
  assert.deepEqual(estadoFactura(100_000, { pagado: 40_000, salda: false }), { pagado: 40_000, saldo: 60_000, estado: 'parcial' });
  assert.equal(estadoFactura(100_000, { pagado: 99_000, salda: false }).estado, 'pagada'); // tolerancia 99 %
  assert.equal(estadoFactura(100_000, { pagado: 98_999, salda: false }).estado, 'parcial');
  assert.deepEqual(estadoFactura(100_000, { pagado: 30_000, salda: true }), { pagado: 30_000, saldo: 0, estado: 'pagada' });
  assert.deepEqual(estadoFactura(100_000, { pagado: 150_000, salda: false }), { pagado: 150_000, saldo: 0, estado: 'pagada' });
});

test('confirmadoPorLab: agrega por laboratorio y decide el estado', () => {
  const facturas = [
    fac({ documento: 1 }),
    fac({ documento: 2, costo: 50_000 }),
    fac({ documento: 3, costo: 20_000 }),
    fac({ nit: '900222', documento: 9, costo: 10_000 }),
  ];
  const pagos = new Map([
    [claveFactura('900111', '01', 1), { pagado: 100_000, salda: false }],
    [claveFactura('900111', '01', 2), { pagado: 10_000, salda: false }],
  ]);
  const r = confirmadoPorLab(facturas, pagos);
  const a = r.get('900111')!;
  assert.equal(a.facturas, 3);
  assert.equal(a.pagadas, 1);
  assert.equal(a.parciales, 1);
  assert.equal(a.pendientes, 1);
  assert.equal(a.pagado, 110_000);
  assert.equal(a.porCobrar, 40_000 + 20_000);
  assert.equal(a.estado, 'parcial');
  assert.equal(r.get('900222')!.estado, 'pendiente');

  pagos.set(claveFactura('900222', '01', 9), { pagado: 0, salda: true });
  assert.equal(confirmadoPorLab(facturas, pagos).get('900222')!.estado, 'pagado');
});

test('confirmadoPorLab: misma factura en otra transacción no se confunde', () => {
  const facturas = [fac({ codigoTransaccion: '01', documento: 5 }), fac({ codigoTransaccion: '62', documento: 5 })];
  const pagos = new Map([[claveFactura('900111', '62', 5), { pagado: 100_000, salda: false }]]);
  const a = confirmadoPorLab(facturas, pagos).get('900111')!;
  assert.equal(a.pagadas, 1);
  assert.equal(a.pendientes, 1);
});

const base = {
  nit: '900111', codigoTransaccion: '01', documento: 77, fechaPago: '2026-10-05', forma: 'nota_credito', valor: 50_000,
};

test('validarPago: acepta un pago bien formado y limpia textos', () => {
  const v = validarPago({ ...base, referencia: '  NC-123 ', observacion: '' }, '2026-11-06');
  assert.ok(v.ok);
  if (v.ok) {
    assert.equal(v.pago.referencia, 'NC-123');
    assert.equal(v.pago.observacion, null);
    assert.equal(v.pago.salda, false);
  }
});

test('validarPago: rechaza datos inválidos', () => {
  const hoy = '2026-11-06';
  assert.equal(validarPago(null, hoy).ok, false);
  assert.equal(validarPago({ ...base, nit: 'abc' }, hoy).ok, false);
  assert.equal(validarPago({ ...base, documento: -1 }, hoy).ok, false);
  assert.equal(validarPago({ ...base, fechaPago: '2026-02-30' }, hoy).ok, false);
  assert.equal(validarPago({ ...base, fechaPago: '2026-11-07' }, hoy).ok, false); // futura
  assert.equal(validarPago({ ...base, forma: 'efectivo' }, hoy).ok, false);
  assert.equal(validarPago({ ...base, valor: -5 }, hoy).ok, false);
  assert.equal(validarPago({ ...base, valor: 'x' }, hoy).ok, false);
  assert.equal(validarPago({ ...base, valor: 0 }, hoy).ok, false);
  assert.equal(validarPago({ ...base, valor: 0, salda: true }, hoy).ok, true);
  assert.equal(validarPago({ ...base, codigoTransaccion: "01'; DROP" }, hoy).ok, false);
});

test('permisos: base + variable, sin distinguir mayúsculas', () => {
  assert.equal(puedeRegistrarPagos('Facturacion@Jotagro.com', ''), true);
  assert.equal(puedeRegistrarPagos('otro@jotagro.com', ''), false);
  assert.equal(puedeRegistrarPagos('patricia@x.com', ' Patricia@X.com , basura'), true);
  assert.equal(puedeRegistrarPagos(null, 'a@b.com'), false);
  assert.equal(registradores('basura').size, 1);
});
