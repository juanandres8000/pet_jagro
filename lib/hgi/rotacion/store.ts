import { getSql as getDb } from '../../pg';
import type { FilaControlDd, Ventana } from '../descuentos/store';
import { GRUPOS, movVacio, type FilaMovimiento, type FilaSaldo, type InfoProducto, type Movimiento } from './mappers';

/**
 * Persistencia de la rotación (migrations/014_rotacion.sql). Mismas reglas que
 * descuentos/store.ts: NO crea tablas (nacerían sin RLS), una transacción por
 * ventana, sustitución por (ventana, lote <> actual) y lecturas EN SERIE.
 */

const TABLAS = ['rot_movimiento', 'rot_saldo', 'rot_producto', 'rot_ventana_control'] as const;
const LOTE_FILAS = 500;

let verificacion: Promise<void> | null = null;
export function verificarTablasRot(): Promise<void> {
  if (!verificacion) {
    verificacion = (async () => {
      const sql = getDb();
      const filas = (await sql`
        SELECT t AS tabla, to_regclass('public.' || t) IS NOT NULL AS existe
          FROM unnest(${TABLAS as unknown as string[]}::text[]) AS t
      `) as unknown as Array<{ tabla: string; existe: boolean }>;
      const faltan = filas.filter((f) => !f.existe).map((f) => f.tabla);
      if (faltan.length) throw new Error(`Faltan tablas de rotación (${faltan.join(', ')}): aplicar migrations/014_rotacion.sql`);
    })().catch((err) => {
      verificacion = null;
      throw err;
    });
  }
  return verificacion;
}

const iso = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const n = (v: unknown) => Number(v ?? 0);

/** Misma forma que el control de descuentos, para reutilizar elegirVentanas. */
export async function readControlRot(): Promise<FilaControlDd[]> {
  await verificarTablasRot();
  const sql = getDb();
  const filas = (await sql`
    SELECT ventana_desde, ventana_hasta, estado, intentos, actualizado_en, lineas, filas, ultimo_error, ok_en
      FROM rot_ventana_control ORDER BY ventana_desde
  `) as unknown as Array<Record<string, unknown>>;
  return filas.map((f) => ({
    desde: iso(f.ventana_desde),
    hasta: iso(f.ventana_hasta),
    estado: f.estado as FilaControlDd['estado'],
    intentos: Number(f.intentos),
    actualizadoEn: new Date(f.actualizado_en as string | Date),
    lineasVenta: Number(f.lineas),
    lineasGuardadas: Number(f.filas),
    lineasCompra: 0,
    docsPrecioCero: 0,
    ultimoError: (f.ultimo_error as string | null) ?? null,
    okEn: f.ok_en ? new Date(f.ok_en as string | Date) : null,
  }));
}

export async function marcarIntentoRot(v: Ventana, lote: string): Promise<void> {
  await verificarTablasRot();
  const sql = getDb();
  await sql`
    INSERT INTO rot_ventana_control (ventana_desde, ventana_hasta, estado, intentos, lote, actualizado_en)
    VALUES (${v.desde}, ${v.hasta}, 'pendiente', 1, ${lote}, NOW())
    ON CONFLICT (ventana_desde, ventana_hasta) DO UPDATE
      SET estado = 'pendiente', intentos = rot_ventana_control.intentos + 1,
          lote = EXCLUDED.lote, actualizado_en = NOW()
  `;
}

export async function marcarErrorRot(v: Ventana, mensaje: string, duracionMs: number): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      UPDATE rot_ventana_control
         SET estado = 'error', ultimo_error = ${mensaje.slice(0, 500)}, duracion_ms = ${duracionMs}, actualizado_en = NOW()
       WHERE ventana_desde = ${v.desde} AND ventana_hasta = ${v.hasta}
    `;
  } catch (err) {
    console.error('[rotacion] no se pudo registrar el error de la ventana:', (err as Error).message);
  }
}

/** Escribe una ventana completa (movimiento + productos + control) en UNA transacción. */
export async function escribirVentanaRot(
  v: Ventana,
  lote: string,
  filas: FilaMovimiento[],
  productos: InfoProducto[],
  lineas: number,
  duracionMs: number,
): Promise<{ borradas: number }> {
  await verificarTablasRot();
  const sql = getDb();
  const mes = v.desde.slice(0, 7);
  const rows = filas.map((f) => ({ ...f, ventana_desde: v.desde, ventana_hasta: v.hasta, mes, lote }));
  const prods = productos.map((p) => ({
    codigo_producto: p.codigo,
    nombre: p.nombre,
    nit_proveedor: p.nitProveedor || null,
    nombre_proveedor: p.nombreProveedor || null,
  }));
  let borradas = 0;
  await sql.begin(async (tx) => {
    for (let i = 0; i < rows.length; i += LOTE_FILAS) {
      await tx`
        INSERT INTO rot_movimiento ${tx(
          rows.slice(i, i + LOTE_FILAS),
          'ventana_desde', 'ventana_hasta', 'mes', 'bodega', 'codigo_producto', 'ent_compra', 'ent_traslado',
          'ent_devolucion', 'ent_otras', 'sal_venta', 'sal_traslado', 'sal_otras', 'lineas', 'lote',
        )}
        ON CONFLICT (ventana_desde, ventana_hasta, bodega, codigo_producto) DO UPDATE
          SET mes = EXCLUDED.mes, ent_compra = EXCLUDED.ent_compra, ent_traslado = EXCLUDED.ent_traslado,
              ent_devolucion = EXCLUDED.ent_devolucion, ent_otras = EXCLUDED.ent_otras,
              sal_venta = EXCLUDED.sal_venta, sal_traslado = EXCLUDED.sal_traslado, sal_otras = EXCLUDED.sal_otras,
              lineas = EXCLUDED.lineas, lote = EXCLUDED.lote
      `;
    }
    const del = (await tx`
      DELETE FROM rot_movimiento
       WHERE ventana_desde = ${v.desde} AND ventana_hasta = ${v.hasta} AND lote <> ${lote}
      RETURNING 1
    `) as unknown as unknown[];
    borradas = del.length;

    // El proveedor más reciente gana; un nombre vacío no pisa uno bueno.
    for (let i = 0; i < prods.length; i += LOTE_FILAS) {
      await tx`
        INSERT INTO rot_producto ${tx(prods.slice(i, i + LOTE_FILAS), 'codigo_producto', 'nombre', 'nit_proveedor', 'nombre_proveedor')}
        ON CONFLICT (codigo_producto) DO UPDATE
          SET nombre = EXCLUDED.nombre,
              nit_proveedor = COALESCE(EXCLUDED.nit_proveedor, rot_producto.nit_proveedor),
              nombre_proveedor = COALESCE(EXCLUDED.nombre_proveedor, rot_producto.nombre_proveedor),
              actualizado_en = NOW()
      `;
    }

    await tx`
      UPDATE rot_ventana_control
         SET estado = 'ok', lineas = ${lineas}, filas = ${rows.length}, duracion_ms = ${duracionMs},
             intentos = 0, ultimo_error = NULL, ok_en = NOW(), actualizado_en = NOW()
       WHERE ventana_desde = ${v.desde} AND ventana_hasta = ${v.hasta}
    `;
  });
  return { borradas };
}

/** Reemplaza la foto de existencias completa en una transacción. Nunca deja la tabla vacía a medias. */
export async function guardarSaldos(saldos: FilaSaldo[], tomadoEn: Date): Promise<void> {
  await verificarTablasRot();
  if (!saldos.length) throw new Error('Inventario de HGINet vacío: no se reemplaza la foto anterior');
  const sql = getDb();
  const rows = saldos.map((s) => ({ ...s, tomado_en: tomadoEn }));
  await sql.begin(async (tx) => {
    await tx`DELETE FROM rot_saldo`;
    for (let i = 0; i < rows.length; i += LOTE_FILAS) {
      await tx`INSERT INTO rot_saldo ${tx(rows.slice(i, i + LOTE_FILAS), 'bodega', 'codigo_producto', 'cantidad', 'costo_unitario', 'tomado_en')}`;
    }
  });
}

// ------------------------------------------------------------- lecturas ---

/** Movimiento sumado por producto en [desdeMes, hastaMes] para las bodegas dadas (null = todas). */
export async function readMovimiento(desdeMes: string, hastaMes: string, bodegas: string[] | null): Promise<Map<string, Movimiento>> {
  await verificarTablasRot();
  const sql = getDb();
  const filas = (await sql`
    SELECT codigo_producto, sum(ent_compra) ent_compra, sum(ent_traslado) ent_traslado,
           sum(ent_devolucion) ent_devolucion, sum(ent_otras) ent_otras, sum(sal_venta) sal_venta,
           sum(sal_traslado) sal_traslado, sum(sal_otras) sal_otras
      FROM rot_movimiento
     WHERE mes BETWEEN ${desdeMes} AND ${hastaMes}
       ${bodegas ? sql`AND bodega = ANY(${bodegas})` : sql``}
     GROUP BY codigo_producto
  `) as unknown as Array<Record<string, unknown>>;
  const out = new Map<string, Movimiento>();
  for (const r of filas) {
    const m = movVacio();
    for (const g of GRUPOS) m[g] = n(r[g]);
    out.set(String(r.codigo_producto), m);
  }
  return out;
}

export interface SaldoLeido {
  porProducto: Map<string, { cantidad: number; costoUnitario: number }>;
  tomadoEn: Date | null;
}

/** Costo unitario: ponderado por la cantidad positiva de cada bodega. */
export async function readSaldos(bodegas: string[] | null): Promise<SaldoLeido> {
  await verificarTablasRot();
  const sql = getDb();
  const filas = (await sql`
    SELECT codigo_producto, sum(cantidad) cantidad,
           CASE WHEN sum(GREATEST(cantidad, 0)) FILTER (WHERE costo_unitario > 0) > 0
                THEN sum(GREATEST(cantidad, 0) * costo_unitario) FILTER (WHERE costo_unitario > 0)
                     / sum(GREATEST(cantidad, 0)) FILTER (WHERE costo_unitario > 0)
                ELSE max(costo_unitario) END AS costo,
           max(tomado_en) tomado_en
      FROM rot_saldo
     ${bodegas ? sql`WHERE bodega = ANY(${bodegas})` : sql``}
     GROUP BY codigo_producto
  `) as unknown as Array<Record<string, unknown>>;
  const porProducto = new Map<string, { cantidad: number; costoUnitario: number }>();
  let tomadoEn: Date | null = null;
  for (const r of filas) {
    porProducto.set(String(r.codigo_producto), { cantidad: n(r.cantidad), costoUnitario: Math.round(n(r.costo)) });
    const t = r.tomado_en ? new Date(r.tomado_en as string | Date) : null;
    if (t && (!tomadoEn || t > tomadoEn)) tomadoEn = t;
  }
  if (!tomadoEn) {
    const [r] = (await sql`SELECT max(tomado_en) t FROM rot_saldo`) as unknown as Array<{ t: Date | null }>;
    tomadoEn = r?.t ? new Date(r.t) : null;
  }
  return { porProducto, tomadoEn };
}

export async function readProductos(): Promise<Map<string, InfoProducto>> {
  await verificarTablasRot();
  const sql = getDb();
  const filas = (await sql`SELECT codigo_producto, nombre, nit_proveedor, nombre_proveedor FROM rot_producto`) as unknown as Array<Record<string, unknown>>;
  return new Map(
    filas.map((r) => [
      String(r.codigo_producto),
      {
        codigo: String(r.codigo_producto),
        nombre: String(r.nombre ?? r.codigo_producto),
        nitProveedor: String(r.nit_proveedor ?? ''),
        nombreProveedor: String(r.nombre_proveedor ?? ''),
      },
    ]),
  );
}

/** Meses con al menos una ingesta exitosa. */
export async function readMesesOkRot(): Promise<string[]> {
  const control = await readControlRot();
  return control.filter((c) => c.okEn !== null).map((c) => c.desde.slice(0, 7));
}
