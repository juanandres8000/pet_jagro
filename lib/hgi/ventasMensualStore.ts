import { getSql as getDb } from '../pg';
import type { VentaPorClave } from './mappers/ventas';

/**
 * Store de agregados mensuales de ventas (tabla hgi_ventas_mensual, una fila por
 * mes). Equivale a migrations/004_hgi_ventas_mensual.sql.
 *
 * El backfill escribe UN mes por corrida de cron, así que el upsert va por
 * clave `mes`: dos corridas concurrentes de meses distintos no se pisan. Ese es
 * el motivo de no usar un dataset de hgi_snapshot, donde habría que leer el
 * array completo, insertar el mes y reescribirlo (read-modify-write).
 */

export interface MesAgregado {
  mes: string; // 'YYYY-MM'
  venta: number;
  costo: number;
  margen: number;
  iva: number;
  descuento: number;
  lineas: number;
  documentos: number;
  clientesNits: string[];
  pedidosNums: string[];
  topClientes: VentaPorClave[];
  topProductos: VentaPorClave[];
  porLinea: VentaPorClave[];
  porVendedor: VentaPorClave[];
  hasta: string;
  parcial: boolean;
  builtAt: Date;
}

/**
 * Se memoiza la PROMESA en vuelo, no un booleano.
 *
 * Con un flag booleano, dos llamadas concurrentes (p.ej. el Promise.all de
 * /api/gerencia, que lee dos años y cartera a la vez) ven `false` las dos y
 * emiten dos CREATE TABLE. Cada uno pide un lock ACCESS EXCLUSIVE y, sobre la
 * única conexión del cliente (max: 1), el segundo espera al primero mientras el
 * primero espera turno en el pipeline: la ruta se cuelga hasta el timeout.
 * Sólo pasa cuando la tabla NO existe todavía — con la tabla creada el
 * IF NOT EXISTS sale barato por NOTICE, que es por lo que los ensure* de
 * snapshotStore y tokenStore nunca lo manifestaron.
 *
 * Compartiendo la promesa, el DDL se emite UNA vez y el resto espera ese mismo
 * resultado. Si falla, se limpia el memo para que el siguiente intento reintente.
 */
let tablePromise: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (!tablePromise) {
    tablePromise = crearTabla().catch((err) => {
      tablePromise = null;
      throw err;
    });
  }
  return tablePromise;
}

async function crearTabla(): Promise<void> {
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS hgi_ventas_mensual (
      mes           TEXT PRIMARY KEY,
      venta         DOUBLE PRECISION NOT NULL DEFAULT 0,
      costo         DOUBLE PRECISION NOT NULL DEFAULT 0,
      margen        DOUBLE PRECISION NOT NULL DEFAULT 0,
      iva           DOUBLE PRECISION NOT NULL DEFAULT 0,
      descuento     DOUBLE PRECISION NOT NULL DEFAULT 0,
      lineas        INTEGER NOT NULL DEFAULT 0,
      documentos    INTEGER NOT NULL DEFAULT 0,
      clientes_nits JSONB,
      pedidos_nums  JSONB,
      top_clientes  JSONB,
      top_productos JSONB,
      por_linea     JSONB,
      por_vendedor  JSONB,
      hasta         TEXT,
      parcial       BOOLEAN NOT NULL DEFAULT FALSE,
      built_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

interface Fila {
  mes: string;
  venta: number;
  costo: number;
  margen: number;
  iva: number;
  descuento: number;
  lineas: number;
  documentos: number;
  clientes_nits: unknown;
  pedidos_nums: unknown;
  top_clientes: unknown;
  top_productos: unknown;
  por_linea: unknown;
  por_vendedor: unknown;
  hasta: string | null;
  parcial: boolean;
  built_at: string | Date;
}

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

const toMes = (f: Fila): MesAgregado => ({
  mes: f.mes,
  venta: Number(f.venta),
  costo: Number(f.costo),
  margen: Number(f.margen),
  iva: Number(f.iva),
  descuento: Number(f.descuento),
  lineas: Number(f.lineas),
  documentos: Number(f.documentos),
  clientesNits: arr<string>(f.clientes_nits),
  pedidosNums: arr<string>(f.pedidos_nums),
  topClientes: arr<VentaPorClave>(f.top_clientes),
  topProductos: arr<VentaPorClave>(f.top_productos),
  porLinea: arr<VentaPorClave>(f.por_linea),
  porVendedor: arr<VentaPorClave>(f.por_vendedor),
  hasta: f.hasta ?? '',
  parcial: !!f.parcial,
  builtAt: new Date(f.built_at),
});

/** Upsert del agregado de UN mes. Atómico: sólo toca su propia fila. */
export async function writeMes(m: Omit<MesAgregado, 'builtAt'>): Promise<Date> {
  await ensureTable();
  const sql = getDb();
  // sql.json() y NO `${JSON.stringify(x)}::jsonb`: postgres.js re-serializa el
  // string y guardaría un jsonb de tipo "string" (ver nota en snapshotStore).
  const rows = (await sql`
    INSERT INTO hgi_ventas_mensual
      (mes, venta, costo, margen, iva, descuento, lineas, documentos,
       clientes_nits, pedidos_nums, top_clientes, top_productos, por_linea, por_vendedor,
       hasta, parcial, built_at)
    VALUES
      (${m.mes}, ${m.venta}, ${m.costo}, ${m.margen}, ${m.iva}, ${m.descuento},
       ${m.lineas}, ${m.documentos},
       ${sql.json(m.clientesNits as never)}, ${sql.json(m.pedidosNums as never)},
       ${sql.json(m.topClientes as never)},
       ${sql.json(m.topProductos as never)}, ${sql.json(m.porLinea as never)},
       ${sql.json(m.porVendedor as never)},
       ${m.hasta}, ${m.parcial}, NOW())
    ON CONFLICT (mes) DO UPDATE
      SET venta = EXCLUDED.venta,
          costo = EXCLUDED.costo,
          margen = EXCLUDED.margen,
          iva = EXCLUDED.iva,
          descuento = EXCLUDED.descuento,
          lineas = EXCLUDED.lineas,
          documentos = EXCLUDED.documentos,
          clientes_nits = EXCLUDED.clientes_nits,
          pedidos_nums = EXCLUDED.pedidos_nums,
          top_clientes = EXCLUDED.top_clientes,
          top_productos = EXCLUDED.top_productos,
          por_linea = EXCLUDED.por_linea,
          por_vendedor = EXCLUDED.por_vendedor,
          hasta = EXCLUDED.hasta,
          parcial = EXCLUDED.parcial,
          built_at = NOW()
    RETURNING built_at
  `) as unknown as Array<{ built_at: string | Date }>;
  return new Date(rows[0].built_at);
}

/** Meses de un año ('YYYY'), ordenados. Devuelve sólo los que existen. */
export async function readAnio(anio: string): Promise<MesAgregado[]> {
  await ensureTable();
  const sql = getDb();
  const rows = (await sql`
    SELECT * FROM hgi_ventas_mensual
     WHERE mes LIKE ${anio + '-%'}
     ORDER BY mes
  `) as unknown as Fila[];
  return rows.map(toMes);
}

/** Un mes puntual, o null si aún no se construyó. */
export async function readMes(mes: string): Promise<MesAgregado | null> {
  await ensureTable();
  const sql = getDb();
  const rows = (await sql`SELECT * FROM hgi_ventas_mensual WHERE mes = ${mes}`) as unknown as Fila[];
  return rows[0] ? toMes(rows[0]) : null;
}

/** Inventario ligero para decidir qué mes toca construir (sin traer los JSONB). */
export async function readCobertura(): Promise<Array<{ mes: string; parcial: boolean; builtAt: Date }>> {
  await ensureTable();
  const sql = getDb();
  const rows = (await sql`
    SELECT mes, parcial, built_at FROM hgi_ventas_mensual ORDER BY mes
  `) as unknown as Array<{ mes: string; parcial: boolean; built_at: string | Date }>;
  return rows.map((r) => ({ mes: r.mes, parcial: !!r.parcial, builtAt: new Date(r.built_at) }));
}
