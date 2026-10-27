import { getSql as getDb } from '../../pg';
import type { AgregadoDd, LineaDd } from './mappers';

/**
 * Persistencia del módulo de descuentos (tablas de migrations/012_descuentos.sql).
 *
 * A diferencia de otros stores, aquí NO hay `CREATE TABLE IF NOT EXISTS` de red de
 * seguridad: una tabla creada por código nace SIN RLS (CLAUDE.md § RLS) y dejaría
 * las líneas de venta expuestas a la anon key. Si falta una tabla se falla con un
 * mensaje claro y se aplica la migración por el puerto 5432.
 *
 * Reglas heredadas del P&G (no re-descubrir):
 *  - Una transacción por ventana: upsert + sustitución + control en un solo acto.
 *  - Sustitución por (ventana, lote <> actual), NUNCA por fecha.
 *  - Lecturas EN SERIE (cliente max:1, trampa 2 del pooler).
 */

export interface Ventana {
  desde: string; // YYYY-MM-01
  hasta: string; // último día del mes
}

export interface FilaControlDd {
  desde: string;
  hasta: string;
  estado: 'pendiente' | 'ok' | 'error';
  intentos: number;
  actualizadoEn: Date;
  lineasVenta: number;
  lineasGuardadas: number;
  lineasCompra: number;
  docsPrecioCero: number;
  ultimoError: string | null;
  /** Última ingesta exitosa; null si nunca la hubo. */
  okEn: Date | null;
}

const TABLAS = ['dd_linea', 'dd_venta_agregado', 'dd_ventana_control'] as const;
const LOTE_FILAS = 500;

let verificacion: Promise<void> | null = null;
/** Comprueba UNA vez por lambda que la migración 012 está aplicada. Memoiza la promesa. */
export function verificarTablas(): Promise<void> {
  if (!verificacion) {
    verificacion = (async () => {
      const sql = getDb();
      const filas = (await sql`
        SELECT t AS tabla, to_regclass('public.' || t) IS NOT NULL AS existe
          FROM unnest(${TABLAS as unknown as string[]}::text[]) AS t
      `) as unknown as Array<{ tabla: string; existe: boolean }>;
      const faltan = filas.filter((f) => !f.existe).map((f) => f.tabla);
      if (faltan.length) {
        throw new Error(`Faltan tablas de descuentos (${faltan.join(', ')}): aplicar migrations/012_descuentos.sql`);
      }
    })().catch((err) => {
      verificacion = null;
      throw err;
    });
  }
  return verificacion;
}

const iso = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

export async function readControlDd(): Promise<FilaControlDd[]> {
  await verificarTablas();
  const sql = getDb();
  const filas = (await sql`
    SELECT ventana_desde, ventana_hasta, estado, intentos, actualizado_en, lineas_venta,
           lineas_guardadas, lineas_compra, docs_precio_cero, ultimo_error, ok_en
      FROM dd_ventana_control
     ORDER BY ventana_desde
  `) as unknown as Array<Record<string, unknown>>;
  return filas.map((f) => ({
    desde: iso(f.ventana_desde),
    hasta: iso(f.ventana_hasta),
    estado: f.estado as FilaControlDd['estado'],
    intentos: Number(f.intentos),
    actualizadoEn: new Date(f.actualizado_en as string | Date),
    lineasVenta: Number(f.lineas_venta),
    lineasGuardadas: Number(f.lineas_guardadas),
    lineasCompra: Number(f.lineas_compra),
    docsPrecioCero: Number(f.docs_precio_cero),
    ultimoError: (f.ultimo_error as string | null) ?? null,
    okEn: f.ok_en ? new Date(f.ok_en as string | Date) : null,
  }));
}

/** Marca el intento ANTES de salir a la red: si el lambda muere, la ventana no queda invisible. */
export async function marcarIntento(v: Ventana, lote: string): Promise<void> {
  await verificarTablas();
  const sql = getDb();
  await sql`
    INSERT INTO dd_ventana_control (ventana_desde, ventana_hasta, estado, intentos, lote, actualizado_en)
    VALUES (${v.desde}, ${v.hasta}, 'pendiente', 1, ${lote}, NOW())
    ON CONFLICT (ventana_desde, ventana_hasta) DO UPDATE
      SET estado = 'pendiente',
          intentos = dd_ventana_control.intentos + 1,
          lote = EXCLUDED.lote,
          actualizado_en = NOW()
  `;
}

/** Registra el fallo sin tumbar la corrida que lo reporta. */
export async function marcarError(v: Ventana, mensaje: string, duracionMs: number): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      UPDATE dd_ventana_control
         SET estado = 'error', ultimo_error = ${mensaje.slice(0, 500)},
             duracion_ms = ${duracionMs}, actualizado_en = NOW()
       WHERE ventana_desde = ${v.desde} AND ventana_hasta = ${v.hasta}
    `;
  } catch (err) {
    console.error('[descuentos] no se pudo registrar el error de la ventana:', (err as Error).message);
  }
}

export interface EscrituraVentana {
  lineas: LineaDd[];
  agregados: AgregadoDd[];
  lineasVenta: number;
  lineasCompra: number;
  docsPrecioCero: number;
  duracionMs: number;
}

/** Escribe una ventana completa en UNA transacción. Devuelve filas sustituidas (borradas). */
export async function escribirVentana(v: Ventana, lote: string, e: EscrituraVentana): Promise<{ borradas: number }> {
  await verificarTablas();
  const sql = getDb();
  let borradas = 0;
  const filas = e.lineas.map((l) => ({ ...l, ventana_desde: v.desde, ventana_hasta: v.hasta, lote }));
  const aggs = e.agregados.map((a) => ({ ...a, ventana_desde: v.desde, ventana_hasta: v.hasta, lote }));

  await sql.begin(async (tx) => {
    for (let i = 0; i < filas.length; i += LOTE_FILAS) {
      await tx`
        INSERT INTO dd_linea ${tx(
          filas.slice(i, i + LOTE_FILAS),
          'id', 'fuente', 'tipo', 'fecha', 'mes', 'codigo_transaccion', 'nombre_transaccion',
          'documento', 'nit_tercero', 'nombre_tercero', 'nit_proveedor', 'nombre_proveedor',
          'codigo_producto', 'nombre_producto', 'cantidad', 'valor_unitario', 'valor_total',
          'descuento', 'costo_unitario', 'costo_total', 'ventana_desde', 'ventana_hasta', 'lote',
        )}
        ON CONFLICT (id) DO UPDATE
          SET fuente = EXCLUDED.fuente, tipo = EXCLUDED.tipo, fecha = EXCLUDED.fecha,
              mes = EXCLUDED.mes, codigo_transaccion = EXCLUDED.codigo_transaccion,
              nombre_transaccion = EXCLUDED.nombre_transaccion, documento = EXCLUDED.documento,
              nit_tercero = EXCLUDED.nit_tercero, nombre_tercero = EXCLUDED.nombre_tercero,
              nit_proveedor = EXCLUDED.nit_proveedor, nombre_proveedor = EXCLUDED.nombre_proveedor,
              codigo_producto = EXCLUDED.codigo_producto, nombre_producto = EXCLUDED.nombre_producto,
              cantidad = EXCLUDED.cantidad, valor_unitario = EXCLUDED.valor_unitario,
              valor_total = EXCLUDED.valor_total, descuento = EXCLUDED.descuento,
              costo_unitario = EXCLUDED.costo_unitario, costo_total = EXCLUDED.costo_total,
              ventana_desde = EXCLUDED.ventana_desde, ventana_hasta = EXCLUDED.ventana_hasta,
              lote = EXCLUDED.lote, ingestado_en = NOW()
      `;
    }
    // Lo que esta ventana trajo antes y ya no trae fue anulado o editado en HGINet.
    const del = (await tx`
      DELETE FROM dd_linea
       WHERE ventana_desde = ${v.desde} AND ventana_hasta = ${v.hasta} AND lote <> ${lote}
      RETURNING id
    `) as unknown as unknown[];
    borradas = del.length;

    for (let i = 0; i < aggs.length; i += LOTE_FILAS) {
      await tx`
        INSERT INTO dd_venta_agregado ${tx(
          aggs.slice(i, i + LOTE_FILAS),
          'ventana_desde', 'ventana_hasta', 'mes', 'nit_proveedor', 'nombre_proveedor',
          'venta_bruta', 'descuento', 'costo', 'costo_precio_cero', 'lista_precio_cero',
          'unidades_precio_cero', 'lineas', 'lote',
        )}
        ON CONFLICT (ventana_desde, ventana_hasta, mes, nit_proveedor) DO UPDATE
          SET nombre_proveedor = EXCLUDED.nombre_proveedor, venta_bruta = EXCLUDED.venta_bruta,
              descuento = EXCLUDED.descuento, costo = EXCLUDED.costo,
              costo_precio_cero = EXCLUDED.costo_precio_cero,
              lista_precio_cero = EXCLUDED.lista_precio_cero,
              unidades_precio_cero = EXCLUDED.unidades_precio_cero,
              lineas = EXCLUDED.lineas, lote = EXCLUDED.lote
      `;
    }
    await tx`
      DELETE FROM dd_venta_agregado
       WHERE ventana_desde = ${v.desde} AND ventana_hasta = ${v.hasta} AND lote <> ${lote}
    `;

    await tx`
      UPDATE dd_ventana_control
         SET estado = 'ok', lineas_venta = ${e.lineasVenta}, lineas_guardadas = ${filas.length},
             lineas_compra = ${e.lineasCompra}, docs_precio_cero = ${e.docsPrecioCero},
             duracion_ms = ${e.duracionMs}, intentos = 0, ultimo_error = NULL, ok_en = NOW(), actualizado_en = NOW()
       WHERE ventana_desde = ${v.desde} AND ventana_hasta = ${v.hasta}
    `;
  });
  return { borradas };
}

// ------------------------------------------------------------- lecturas ---

export interface FilaLab {
  nit: string;
  nombre: string;
  ventaBruta: number;
  descuento: number;
  costo: number;
  costoPrecioCero: number;
  listaPrecioCero: number;
  unidadesPrecioCero: number;
  /** Mercancía gratis en facturas de compra (40/45), valorada a CostoTotal. */
  gratisCompra: number;
  unidadesGratisCompra: number;
  /** Entradas de inventario por bonificados (33). */
  entradaBonificado: number;
  /** Descuento de línea en facturas de compra pagadas (40/45, sin las gratis). */
  descuentoFacturaCompra: number;
  /** Crédito neto a 14352290 (descuento en compra al pagar), por tercero. */
  descuentoAlPagar: number;
}

const n = (v: unknown) => Number(v ?? 0);

/**
 * Resumen por laboratorio de un rango de meses [desdeMes, hastaMes].
 * Las cuatro lecturas van en serie.
 */
export async function readResumenLabs(desdeMes: string, hastaMes: string): Promise<FilaLab[]> {
  await verificarTablas();
  const sql = getDb();
  const labs = new Map<string, FilaLab>();
  const fila = (nit: string, nombre: string): FilaLab => {
    let f = labs.get(nit);
    if (!f) {
      f = {
        nit, nombre, ventaBruta: 0, descuento: 0, costo: 0, costoPrecioCero: 0, listaPrecioCero: 0,
        unidadesPrecioCero: 0, gratisCompra: 0, unidadesGratisCompra: 0, entradaBonificado: 0,
        descuentoFacturaCompra: 0, descuentoAlPagar: 0,
      };
      labs.set(nit, f);
    }
    if (!f.nombre && nombre) f.nombre = nombre;
    return f;
  };

  const ventas = (await sql`
    SELECT nit_proveedor, max(nombre_proveedor) AS nombre, sum(venta_bruta) vb, sum(descuento) d, sum(costo) c,
           sum(costo_precio_cero) cp0, sum(lista_precio_cero) lp0, sum(unidades_precio_cero) up0
      FROM dd_venta_agregado
     WHERE mes BETWEEN ${desdeMes} AND ${hastaMes}
     GROUP BY nit_proveedor
  `) as unknown as Array<Record<string, unknown>>;
  for (const r of ventas) {
    const f = fila(String(r.nit_proveedor), String(r.nombre ?? ''));
    f.ventaBruta = n(r.vb); f.descuento = n(r.d); f.costo = n(r.c);
    f.costoPrecioCero = n(r.cp0); f.listaPrecioCero = n(r.lp0); f.unidadesPrecioCero = n(r.up0);
  }

  const compras = (await sql`
    SELECT nit_proveedor, max(nombre_proveedor) AS nombre,
           sum(costo_total) FILTER (WHERE tipo = 'compra_gratis') AS gratis,
           sum(cantidad)    FILTER (WHERE tipo = 'compra_gratis') AS und_gratis,
           sum(costo_total) FILTER (WHERE tipo = 'entrada_bonificado') AS bonif,
           sum(descuento)   FILTER (WHERE tipo = 'compra') AS desc_fact
      FROM dd_linea
     WHERE fuente = 'compra' AND mes BETWEEN ${desdeMes} AND ${hastaMes}
     GROUP BY nit_proveedor
  `) as unknown as Array<Record<string, unknown>>;
  for (const r of compras) {
    const f = fila(String(r.nit_proveedor), String(r.nombre ?? ''));
    f.gratisCompra = n(r.gratis); f.unidadesGratisCompra = n(r.und_gratis);
    f.entradaBonificado = n(r.bonif); f.descuentoFacturaCompra = n(r.desc_fact);
  }

  // Descuento en compra al pagar: contabilidad ya ingestada por el P&G (lectura).
  // Va por TERCERO (a quién se le pagó), que casi siempre es el laboratorio.
  const alPagar = (await sql`
    SELECT tercero, sum(credito) - sum(debito) AS neto
      FROM pyg_movimiento
     WHERE cuenta = '14352290' AND periodo <> 13 AND mes BETWEEN ${desdeMes} AND ${hastaMes}
     GROUP BY tercero
  `) as unknown as Array<Record<string, unknown>>;
  for (const r of alPagar) {
    const nit = String(r.tercero ?? '');
    if (!nit) continue;
    fila(nit, '').descuentoAlPagar = n(r.neto);
  }

  // Nombre para terceros que sólo aparecen en contabilidad.
  const sinNombre = [...labs.values()].filter((f) => !f.nombre).map((f) => f.nit);
  if (sinNombre.length) {
    const nombres = (await sql`
      SELECT nit_tercero AS nit, max(nombre_tercero) AS nombre
        FROM dd_linea WHERE fuente = 'compra' AND nit_tercero = ANY(${sinNombre})
       GROUP BY nit_tercero
    `) as unknown as Array<{ nit: string; nombre: string }>;
    for (const r of nombres) labs.get(r.nit)!.nombre = r.nombre;
  }
  return [...labs.values()];
}

export interface LineaReporte {
  codigoTransaccion: string;
  documento: number;
  fecha: string;
  codigoProducto: string;
  producto: string;
  cantidad: number;
  precioCero: boolean;
  valorUnitario: number;
  costoTotal: number;
  cliente: string;
}

/**
 * Líneas del reporte "PRECIO CERO <LAB>": de cada factura con precio cero de ese
 * laboratorio, las líneas de SUS productos (pagadas y regaladas), como el Excel.
 */
export async function readReportePrecioCero(nit: string, desde: string, hasta: string): Promise<LineaReporte[]> {
  await verificarTablas();
  const sql = getDb();
  const filas = (await sql`
    WITH docs AS (
      SELECT DISTINCT codigo_transaccion, documento
        FROM dd_linea
       WHERE fuente = 'venta' AND tipo = 'venta_precio_cero' AND nit_proveedor = ${nit}
         AND fecha BETWEEN ${desde} AND ${hasta}
    )
    SELECT l.codigo_transaccion, l.documento, l.fecha, l.codigo_producto, l.nombre_producto,
           l.cantidad, l.tipo, l.valor_unitario, l.costo_total, l.nombre_tercero
      FROM dd_linea l
      JOIN docs d ON d.codigo_transaccion = l.codigo_transaccion AND d.documento = l.documento
     WHERE l.fuente = 'venta' AND l.nit_proveedor = ${nit}
     ORDER BY l.fecha, l.codigo_transaccion, l.documento, l.codigo_producto, l.tipo DESC, l.id
  `) as unknown as Array<Record<string, unknown>>;
  return filas.map((r) => ({
    codigoTransaccion: String(r.codigo_transaccion),
    documento: Number(r.documento),
    fecha: iso(r.fecha),
    codigoProducto: String(r.codigo_producto),
    producto: String(r.nombre_producto ?? ''),
    cantidad: n(r.cantidad),
    precioCero: r.tipo === 'venta_precio_cero',
    valorUnitario: n(r.valor_unitario),
    costoTotal: n(r.costo_total),
    cliente: String(r.nombre_tercero ?? ''),
  }));
}

/** Meses con al menos una ingesta exitosa (la API no muestra cifras de meses sin datos). */
export async function readMesesOk(): Promise<string[]> {
  const control = await readControlDd();
  return control.filter((c) => c.okEn !== null).map((c) => c.desde.slice(0, 7));
}
