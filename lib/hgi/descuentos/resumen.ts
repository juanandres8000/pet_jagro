import type { Celda, Hoja } from '../../xlsx';
import type { FilaLab, LineaReporte } from './store';

/**
 * Cálculos PUROS del módulo de descuentos (cubiertos por tests/descuentos.test.ts).
 *
 * Vocabulario (el mismo de la vista y de docs/DESCUENTOS.md):
 *  - Precio cero entregado: costo de lo que Jotagro regaló en factura.
 *  - Recibido en mercancía: unidades gratis en compras (40/45) + entradas por
 *    bonificados (33). Es compensación del laboratorio sin ambigüedad.
 *  - Descuentos en compra: en la factura de compra y al pagar (14352290). PUEDEN
 *    mezclar descuentos comerciales normales con la compensación del precio
 *    cero; por eso se muestran aparte y la "cobertura" se llama observada.
 */

export interface LabResumen {
  nit: string;
  nombre: string;
  ventaNeta: number;
  costo: number;
  margen: number;
  margenPct: number | null;
  /** Margen si el costo del precio cero no estuviera en el costo de ventas. */
  margenSinPrecioCeroPct: number | null;
  descuentoLinea: number;
  precioCero: { costo: number; lista: number; unidades: number; pctVenta: number | null };
  recibidoMercancia: number;
  unidadesRecibidas: number;
  descuentoFacturaCompra: number;
  descuentoAlPagar: number;
  /** Mercancía + descuentos en compra. */
  compensacionObservada: number;
  /** compensacionObservada / costo precio cero (null si no hubo precio cero). */
  cobertura: number | null;
  /** max(0, precio cero − compensación observada). */
  brecha: number;
  estado: 'sin_precio_cero' | 'cubierto' | 'parcial' | 'sin_compensacion';
}

const pct = (a: number, b: number) => (b ? a / b : null);
const r0 = (n: number) => Math.round(n);

/** Umbral para llamar "cubierto" a un laboratorio (tolera redondeos y desfase de fechas). */
export const UMBRAL_CUBIERTO = 0.95;

export function resumirLab(f: FilaLab): LabResumen {
  const ventaNeta = f.ventaBruta - f.descuento;
  const margen = ventaNeta - f.costo;
  const recibidoMercancia = f.gratisCompra + f.entradaBonificado;
  const compensacionObservada = recibidoMercancia + f.descuentoFacturaCompra + Math.max(0, f.descuentoAlPagar);
  const cobertura = f.costoPrecioCero > 0 ? compensacionObservada / f.costoPrecioCero : null;
  let estado: LabResumen['estado'];
  if (f.costoPrecioCero <= 0) estado = 'sin_precio_cero';
  else if (compensacionObservada <= 0) estado = 'sin_compensacion';
  else if ((cobertura ?? 0) >= UMBRAL_CUBIERTO) estado = 'cubierto';
  else estado = 'parcial';
  return {
    nit: f.nit,
    nombre: f.nombre || f.nit,
    ventaNeta: r0(ventaNeta),
    costo: r0(f.costo),
    margen: r0(margen),
    margenPct: pct(margen, ventaNeta),
    margenSinPrecioCeroPct: pct(margen + f.costoPrecioCero, ventaNeta),
    descuentoLinea: r0(f.descuento),
    precioCero: {
      costo: r0(f.costoPrecioCero),
      lista: r0(f.listaPrecioCero),
      unidades: f.unidadesPrecioCero,
      pctVenta: pct(f.costoPrecioCero, ventaNeta),
    },
    recibidoMercancia: r0(recibidoMercancia),
    unidadesRecibidas: f.unidadesGratisCompra,
    descuentoFacturaCompra: r0(f.descuentoFacturaCompra),
    descuentoAlPagar: r0(f.descuentoAlPagar),
    compensacionObservada: r0(compensacionObservada),
    cobertura,
    brecha: r0(Math.max(0, f.costoPrecioCero - compensacionObservada)),
    estado,
  };
}

export interface Totales {
  ventaNeta: number;
  costo: number;
  margen: number;
  margenPct: number | null;
  margenSinPrecioCeroPct: number | null;
  descuentoLinea: number;
  precioCeroCosto: number;
  precioCeroLista: number;
  precioCeroPctVenta: number | null;
  recibidoMercancia: number;
  descuentoFacturaCompra: number;
  descuentoAlPagar: number;
  brecha: number;
  labsConPrecioCero: number;
  labsConBrecha: number;
}

export function totalizar(labs: LabResumen[]): Totales {
  const s = (k: (l: LabResumen) => number) => labs.reduce((a, l) => a + k(l), 0);
  const ventaNeta = s((l) => l.ventaNeta);
  const margen = s((l) => l.margen);
  const p0 = s((l) => l.precioCero.costo);
  return {
    ventaNeta,
    costo: s((l) => l.costo),
    margen,
    margenPct: pct(margen, ventaNeta),
    margenSinPrecioCeroPct: pct(margen + p0, ventaNeta),
    descuentoLinea: s((l) => l.descuentoLinea),
    precioCeroCosto: p0,
    precioCeroLista: s((l) => l.precioCero.lista),
    precioCeroPctVenta: pct(p0, ventaNeta),
    recibidoMercancia: s((l) => l.recibidoMercancia),
    descuentoFacturaCompra: s((l) => l.descuentoFacturaCompra),
    descuentoAlPagar: s((l) => l.descuentoAlPagar),
    brecha: s((l) => l.brecha),
    labsConPrecioCero: labs.filter((l) => l.precioCero.costo > 0).length,
    labsConBrecha: labs.filter((l) => l.brecha > 0).length,
  };
}

/** Orden por defecto: más precio cero primero; empate por nombre. */
export const ordenarLabs = (labs: LabResumen[]) =>
  [...labs].sort((a, b) => b.precioCero.costo - a.precioCero.costo || a.nombre.localeCompare(b.nombre, 'es'));

// ------------------------------------------------------------- reporte ---

export interface BloqueFactura {
  codigoTransaccion: string;
  documento: number;
  fecha: string;
  cliente: string;
  lineas: Array<{ codigoProducto: string; producto: string; cantidad: number; precioCero: boolean; valorUnitario: number; costoTotal: number }>;
}

/** Agrupa las líneas del reporte por factura, en el orden en que vienen. */
export function agruparPorFactura(lineas: LineaReporte[]): BloqueFactura[] {
  const out: BloqueFactura[] = [];
  const idx = new Map<string, BloqueFactura>();
  for (const l of lineas) {
    const k = `${l.codigoTransaccion}|${l.documento}`;
    let b = idx.get(k);
    if (!b) {
      b = { codigoTransaccion: l.codigoTransaccion, documento: l.documento, fecha: l.fecha, cliente: l.cliente, lineas: [] };
      idx.set(k, b);
      out.push(b);
    }
    b.lineas.push({
      codigoProducto: l.codigoProducto,
      producto: l.producto,
      cantidad: l.cantidad,
      precioCero: l.precioCero,
      valorUnitario: l.valorUnitario,
      costoTotal: l.costoTotal,
    });
  }
  return out;
}

/** Resumen de unidades bonificadas por producto (columnas F–G del Excel manual). */
export function bonificadoPorProducto(bloques: BloqueFactura[]) {
  const m = new Map<string, { producto: string; unidades: number; costo: number; lista: number }>();
  for (const b of bloques)
    for (const l of b.lineas) {
      if (!l.precioCero) continue;
      const x = m.get(l.producto) ?? { producto: l.producto, unidades: 0, costo: 0, lista: 0 };
      x.unidades += l.cantidad;
      x.costo += l.costoTotal;
      x.lista += l.valorUnitario * l.cantidad;
      m.set(l.producto, x);
    }
  return [...m.values()].sort((a, b) => b.unidades - a.unidades || a.producto.localeCompare(b.producto, 'es'));
}

const fechaUtc = (iso: string) => new Date(`${iso}T00:00:00Z`);

/**
 * Hojas del .xlsx "PRECIO CERO <LAB> <periodo>". La primera replica el formato del
 * Excel que Jotagro arma a mano (encabezado, bloque por factura con TR, DOCUMEN y
 * FECHA, líneas código | producto | cantidad, y el resumen BONIFICADO a la
 * derecha). La segunda trae el detalle valorizado para la conciliación.
 */
export function hojasReporte(
  lab: { nit: string; nombre: string },
  desde: string,
  hasta: string,
  lineas: LineaReporte[],
  /** Meses del periodo SIN datos ingestados: el reporte estaría incompleto y lo dice. */
  mesesSinDatos: string[] = [],
): Hoja[] {
  const bloques = agruparPorFactura(lineas);
  const resumen = bonificadoPorProducto(bloques);
  const aviso = mesesSinDatos.length
    ? `ADVERTENCIA: REPORTE INCOMPLETO, SIN DATOS PARA ${mesesSinDatos.join(', ')}`
    : null;
  const filas: Celda[][] = [
    [null, null, 'JOTAGRO DISTRIBUCIONES ESPECIALIZADAS S.A.S.', null, null, aviso],
    [null, null, `PRECIO CERO ${lab.nombre} (NIT ${lab.nit})`],
    [null, null, 'DETALLE'],
    [null, null, `ENTRE ${desde} Y ${hasta}`],
    ['TR', 'DOCUMEN', 'FECHA', 'CANTIDAD', 'TIPO', 'PRODUCTO', 'BONIFICADO'],
  ];
  const cuerpo: Celda[][] = [];
  for (const b of bloques) {
    cuerpo.push([b.codigoTransaccion, b.documento, fechaUtc(b.fecha)]);
    for (const l of b.lineas) cuerpo.push([l.codigoProducto, null, l.producto, l.cantidad, l.precioCero ? 'PRECIO CERO' : 'PAGADO']);
  }
  // El resumen va en F–G desde la primera fila del cuerpo, como en el Excel manual.
  const altas = Math.max(cuerpo.length, resumen.length);
  for (let i = 0; i < altas; i++) {
    const fila: Celda[] = cuerpo[i] ? [...cuerpo[i]] : [];
    while (fila.length < 5) fila.push(null);
    if (resumen[i]) fila.push(resumen[i].producto, resumen[i].unidades);
    filas.push(fila);
  }
  const totalUnd = resumen.reduce((s, r) => s + r.unidades, 0);
  filas.push([], [null, null, 'TOTAL FACTURAS', bloques.length, null, 'TOTAL UNIDADES BONIFICADAS', totalUnd]);

  const detalle: Celda[][] = [
    ...(aviso ? [[aviso]] : []),
    ['TR', 'DOCUMENTO', 'FECHA', 'CLIENTE', 'CÓDIGO', 'PRODUCTO', 'CANTIDAD', 'TIPO', 'PRECIO LISTA UNIT.', 'VALOR LISTA', 'COSTO'],
  ];
  for (const b of bloques)
    for (const l of b.lineas)
      detalle.push([
        b.codigoTransaccion,
        b.documento,
        fechaUtc(b.fecha),
        b.cliente,
        l.codigoProducto,
        l.producto,
        l.cantidad,
        l.precioCero ? 'PRECIO CERO' : 'PAGADO',
        l.valorUnitario,
        l.precioCero ? l.valorUnitario * l.cantidad : null,
        l.precioCero ? l.costoTotal : null,
      ]);
  const p0 = bloques.flatMap((b) => b.lineas.filter((l) => l.precioCero));
  detalle.push(
    [],
    [null, null, null, null, null, 'TOTAL PRECIO CERO', p0.reduce((s, l) => s + l.cantidad, 0), null, null,
      p0.reduce((s, l) => s + l.valorUnitario * l.cantidad, 0), p0.reduce((s, l) => s + l.costoTotal, 0)],
  );

  return [
    { nombre: 'Precio cero', filas, anchos: [12, 10, 52, 10, 13, 52, 12] },
    { nombre: 'Detalle valorizado', filas: detalle, anchos: [6, 11, 11, 36, 12, 52, 10, 13, 16, 14, 14] },
  ];
}

/** Nombre de archivo seguro: sólo letras, números, espacio, punto y guión. */
export function nombreArchivo(lab: string, desde: string, hasta: string): string {
  const limpio = lab
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return `PRECIO CERO ${limpio || 'LABORATORIO'} ${desde} a ${hasta}.xlsx`;
}
