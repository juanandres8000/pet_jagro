/**
 * Descuentos diferenciados — clasificación PURA de líneas de HGINet.
 * Sin red ni BD: todo lo que decide qué es "precio cero" o "bonificado" vive
 * aquí y está cubierto por tests/descuentos.test.ts. Ver docs/DESCUENTOS.md.
 *
 * ── QUÉ ES PRECIO CERO (validado contra los Excel manuales de Jotagro) ─────────
 * Una línea de FACTURA de venta con `ValorTotalDetalle = 0` y cantidad > 0.
 * `ValorUnitario` conserva el precio de lista, `CostoTotal` trae el costo pleno y
 * `ValorDescuentoDetalle = 0`: para HGINet no es un descuento, es costo sin
 * ingreso. Contra "PRECIO CERO CARVAL AGOSTO 16 AL 31" cuadró 52/52 facturas y
 * contra "PRECIO CERO PHARMAVET SEPTIEMBRE 2026" 8/8.
 * Las notas crédito con valor 0 (41 en ago–sep) NO son regalos: se excluyen.
 *
 * ── LO QUE DEVUELVE EL LABORATORIO (compras, tipo_documento=0) ─────────────────
 *  - 40 FACTURA DE COMPRA y 45 FACTURA DE COMPRA PRECIO CERO: una línea con
 *    `ValorTotalDetalle = 0` y cantidad > 0 es mercancía gratis del laboratorio.
 *    Una línea con descuento ≥ valor (la 45 suele venir así) también es gratis.
 *  - 33 ENTRADA DE INVENTARIO POR BONIFICADOS: bonificado que entra sin factura.
 *  - 32 SALIDA DE INVENTARIO POR BONIFICADOS y 05 NOTA DEBITO PROVEEDORES: se
 *    guardan para auditoría, no suman como recibido.
 *  El "descuento en compra al pagar" no está aquí: sale de la contabilidad
 *  (cuenta 14352290 en pyg_movimiento), ver store.ts.
 *
 * Signos y venta neta: se reutiliza `toVentaLinea` de mappers/ventas.ts para que
 * el margen de este módulo use EXACTAMENTE las reglas de Gerencia (costo de nota
 * crédito en negativo, venta neta = bruta − descuento de línea).
 */

import { toVentaLinea, type HgiVentaLinea } from '../mappers/ventas';

export type TipoLinea =
  | 'venta_precio_cero'
  | 'venta_acompana' // otra línea de una factura que tiene precio cero
  | 'compra'
  | 'compra_gratis'
  | 'entrada_bonificado'
  | 'salida_bonificado'
  | 'nota_debito_proveedor';

/** Transacciones de compra/inventario que se piden a HGINet, con su tipo base. */
export const TRANSACCIONES_COMPRA: Record<string, TipoLinea> = {
  '40': 'compra',
  '45': 'compra',
  '33': 'entrada_bonificado',
  '32': 'salida_bonificado',
  '05': 'nota_debito_proveedor',
};

/** Fila cruda de ObtenerDetalleReporte con los campos que el módulo necesita. */
export interface HgiDetalleLinea extends HgiVentaLinea {
  Id?: number | string;
  CostoUnitario?: number | string;
}

/** Fila de dd_linea. Montos con signo tal como los guarda la tabla. */
export interface LineaDd {
  id: number;
  fuente: 'venta' | 'compra';
  tipo: TipoLinea;
  fecha: string;
  mes: string;
  codigo_transaccion: string;
  nombre_transaccion: string;
  documento: number;
  nit_tercero: string;
  nombre_tercero: string;
  nit_proveedor: string;
  nombre_proveedor: string;
  codigo_producto: string;
  nombre_producto: string;
  cantidad: number;
  valor_unitario: number;
  valor_total: number;
  descuento: number;
  costo_unitario: number;
  costo_total: number;
}

/** Fila de dd_venta_agregado (sin ventana ni lote, que pone el store). */
export interface AgregadoDd {
  mes: string;
  nit_proveedor: string;
  nombre_proveedor: string;
  venta_bruta: number;
  descuento: number;
  costo: number;
  costo_precio_cero: number;
  lista_precio_cero: number;
  unidades_precio_cero: number;
  lineas: number;
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());
const num = (v: unknown): number => {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};
/** Redondeo a centavos: los NUMERIC(18,2) no deben recibir basura de coma flotante. */
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Código de transacción normalizado a 2 dígitos ('4' → '04'), como lo muestra HGINet. */
export const codigoTransaccion = (v: unknown): string => {
  const s = str(v);
  return /^\d$/.test(s) ? `0${s}` : s;
};

export const esNotaCredito = (nombre: unknown): boolean => /NOTA\s*CREDITO/i.test(str(nombre));

/** ¿Es una línea de venta en precio cero? (regla de arriba) */
export function esPrecioCeroVenta(f: HgiDetalleLinea): boolean {
  return !esNotaCredito(f.NombreTransaccion) && num(f.ValorTotalDetalle) === 0 && num(f.CantidadDocumento) > 0;
}

/** ¿Es mercancía gratis dentro de una factura de compra? */
export function esGratisCompra(f: HgiDetalleLinea): boolean {
  const valor = num(f.ValorTotalDetalle);
  const cantidad = num(f.CantidadDocumento);
  if (cantidad <= 0) return false;
  return valor === 0 || (valor > 0 && num(f.ValorDescuentoDetalle) >= valor);
}

/** Clave de documento: transacción + número (la llave de factura de HGINet). */
export const claveDoc = (f: HgiDetalleLinea) => `${codigoTransaccion(f.CodigoTransaccion)}|${str(f.NumeroDocumento)}`;

/** Proyecta una fila cruda. Devuelve null si le falta Id, fecha o documento. */
export function aLineaDd(f: HgiDetalleLinea, fuente: 'venta' | 'compra', tipo: TipoLinea): LineaDd | null {
  const id = num(f.Id);
  const fecha = str(f.Fecha).slice(0, 10);
  const documento = num(f.NumeroDocumento);
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !documento) return null;
  return {
    id,
    fuente,
    tipo,
    fecha,
    mes: fecha.slice(0, 7),
    codigo_transaccion: codigoTransaccion(f.CodigoTransaccion),
    nombre_transaccion: str(f.NombreTransaccion),
    documento,
    nit_tercero: str(f.NitTercero),
    nombre_tercero: str(f.NombreTercero),
    nit_proveedor: str(f.NitProveedor),
    nombre_proveedor: str(f.NombreProveedor),
    codigo_producto: str(f.CodigoProducto),
    nombre_producto: str(f.NombreProducto),
    cantidad: r2(num(f.CantidadDocumento)),
    valor_unitario: r2(num(f.ValorUnitario)),
    valor_total: r2(num(f.ValorTotalDetalle)),
    descuento: r2(num(f.ValorDescuentoDetalle)),
    costo_unitario: r2(num(f.CostoUnitario)),
    costo_total: r2(num(f.CostoTotal)),
  };
}

export interface ResultadoVentas {
  /** Líneas a guardar: todas las de facturas con al menos un precio cero. */
  lineas: LineaDd[];
  agregados: AgregadoDd[];
  lineasLeidas: number;
  docsPrecioCero: number;
  /** Filas que no se pudieron proyectar (sin Id/fecha/documento). Deben ser 0. */
  descartadas: number;
}

/**
 * Clasifica las líneas de VENTA de una ventana: guarda las facturas con precio
 * cero completas y agrega todas las ventas por mes y laboratorio.
 */
export function clasificarVentas(filas: HgiDetalleLinea[]): ResultadoVentas {
  const docsP0 = new Set<string>();
  for (const f of filas) if (esPrecioCeroVenta(f)) docsP0.add(claveDoc(f));

  const lineas: LineaDd[] = [];
  const agg = new Map<string, AgregadoDd>();
  let descartadas = 0;

  for (const f of filas) {
    const v = toVentaLinea(f);
    if (!v) {
      descartadas++;
      continue;
    }
    const p0 = esPrecioCeroVenta(f);
    const nit = str(f.NitProveedor);
    const clave = `${v.fecha.slice(0, 7)}|${nit}`;
    let a = agg.get(clave);
    if (!a) {
      a = {
        mes: v.fecha.slice(0, 7),
        nit_proveedor: nit,
        nombre_proveedor: str(f.NombreProveedor) || nit,
        venta_bruta: 0,
        descuento: 0,
        costo: 0,
        costo_precio_cero: 0,
        lista_precio_cero: 0,
        unidades_precio_cero: 0,
        lineas: 0,
      };
      agg.set(clave, a);
    }
    a.venta_bruta += v.ventaBruta ?? v.venta + v.descuento;
    a.descuento += v.descuento;
    a.costo += v.costo;
    a.lineas += 1;
    if (p0) {
      a.costo_precio_cero += num(f.CostoTotal);
      a.lista_precio_cero += num(f.ValorUnitario) * num(f.CantidadDocumento);
      a.unidades_precio_cero += num(f.CantidadDocumento);
    }

    if (docsP0.has(claveDoc(f))) {
      const l = aLineaDd(f, 'venta', p0 ? 'venta_precio_cero' : 'venta_acompana');
      if (l) lineas.push(l);
      else descartadas++;
    }
  }

  const agregados = [...agg.values()].map((a) => ({
    ...a,
    venta_bruta: r2(a.venta_bruta),
    descuento: r2(a.descuento),
    costo: r2(a.costo),
    costo_precio_cero: r2(a.costo_precio_cero),
    lista_precio_cero: r2(a.lista_precio_cero),
    unidades_precio_cero: r2(a.unidades_precio_cero),
  }));
  return { lineas, agregados, lineasLeidas: filas.length, docsPrecioCero: docsP0.size, descartadas };
}

/** Clasifica las líneas de COMPRA de una transacción concreta. */
export function clasificarCompras(filas: HgiDetalleLinea[], transaccion: string): { lineas: LineaDd[]; descartadas: number } {
  const base = TRANSACCIONES_COMPRA[transaccion];
  if (!base) throw new Error(`Transacción de compra no soportada: ${transaccion}`);
  const lineas: LineaDd[] = [];
  let descartadas = 0;
  for (const f of filas) {
    // HGINet ya filtra por codigo_transaccion; si algo distinto se cuela, no se
    // clasifica con el tipo equivocado.
    if (codigoTransaccion(f.CodigoTransaccion) !== transaccion) {
      descartadas++;
      continue;
    }
    const tipo: TipoLinea = base === 'compra' && esGratisCompra(f) ? 'compra_gratis' : base;
    const l = aLineaDd(f, 'compra', tipo);
    if (l) lineas.push(l);
    else descartadas++;
  }
  return { lineas, descartadas };
}

/**
 * Regla del par "N + M" para el reporte: unidades pagadas y regaladas del mismo
 * producto en la misma factura. Devuelve null si no hubo pagadas (obsequio de
 * otro producto, p. ej. sobres de champú con un frasco).
 */
export function reglaPar(pagadas: number, regaladas: number): string | null {
  return pagadas > 0 ? `${pagadas}+${regaladas}` : null;
}
