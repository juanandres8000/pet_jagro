import { getSql as getDb } from '../../pg';
import { verificarTablas } from './store';
import { claveFactura, type FacturaP0, type PagadoFactura, type PagoDd, type PagoNuevo, type FormaPago } from './pagos';

/**
 * Persistencia de los pagos del precio cero (migrations/013_dd_pago.sql).
 * Como store.ts: NO crea la tabla (nacería sin RLS). Lecturas en serie.
 */

let verificacion: Promise<boolean> | null = null;
/** ¿Está aplicada la 013? Memoiza la promesa; si falla la consulta, reintenta la próxima vez. */
export function tablaPagosExiste(): Promise<boolean> {
  if (!verificacion) {
    verificacion = (async () => {
      const sql = getDb();
      const [r] = (await sql`SELECT to_regclass('public.dd_pago') IS NOT NULL AS existe`) as unknown as Array<{ existe: boolean }>;
      if (!r.existe) verificacion = null; // al aplicarla, la próxima llamada la ve
      return r.existe;
    })().catch((err) => {
      verificacion = null;
      throw err;
    });
  }
  return verificacion;
}

async function exigirTablaPagos(): Promise<void> {
  if (!(await tablaPagosExiste())) throw new Error('Falta la tabla dd_pago: aplicar migrations/013_dd_pago.sql');
}

const iso = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const n = (v: unknown) => Number(v ?? 0);

/**
 * Facturas de venta con precio cero en [desde, hasta] (fechas YYYY-MM-DD), por
 * laboratorio. `nit` opcional: sin él trae todos los laboratorios.
 */
export async function readFacturasP0(desde: string, hasta: string, nit?: string): Promise<FacturaP0[]> {
  await verificarTablas();
  const sql = getDb();
  const filas = (await sql`
    SELECT nit_proveedor, codigo_transaccion, documento, min(fecha) AS fecha, max(nombre_tercero) AS cliente,
           sum(costo_total) AS costo, sum(valor_unitario * cantidad) AS lista, sum(cantidad) AS unidades
      FROM dd_linea
     WHERE fuente = 'venta' AND tipo = 'venta_precio_cero'
       AND fecha BETWEEN ${desde} AND ${hasta}
       AND nit_proveedor IS NOT NULL AND nit_proveedor <> ''
       ${nit ? sql`AND nit_proveedor = ${nit}` : sql``}
     GROUP BY nit_proveedor, codigo_transaccion, documento
     ORDER BY min(fecha), codigo_transaccion, documento
  `) as unknown as Array<Record<string, unknown>>;
  return filas.map((r) => ({
    nit: String(r.nit_proveedor),
    codigoTransaccion: String(r.codigo_transaccion),
    documento: Number(r.documento),
    fecha: iso(r.fecha),
    cliente: String(r.cliente ?? ''),
    costo: Math.round(n(r.costo)),
    lista: Math.round(n(r.lista)),
    unidades: n(r.unidades),
  }));
}

/**
 * Lo pagado (vigente) por factura de los laboratorios dados. Se lee por
 * laboratorio y no por factura: son pocas filas y evita armar listas largas.
 */
export async function readPagadoPorFactura(nits: string[]): Promise<Map<string, PagadoFactura>> {
  const out = new Map<string, PagadoFactura>();
  if (!nits.length || !(await tablaPagosExiste())) return out;
  const sql = getDb();
  const filas = (await sql`
    SELECT nit_proveedor, codigo_transaccion, documento, sum(valor) AS pagado, bool_or(salda) AS salda
      FROM dd_pago
     WHERE anulado_en IS NULL AND nit_proveedor = ANY(${nits})
     GROUP BY nit_proveedor, codigo_transaccion, documento
  `) as unknown as Array<Record<string, unknown>>;
  for (const r of filas) {
    out.set(claveFactura(String(r.nit_proveedor), String(r.codigo_transaccion), Number(r.documento)), {
      pagado: n(r.pagado),
      salda: Boolean(r.salda),
    });
  }
  return out;
}

const aPago = (r: Record<string, unknown>): PagoDd => ({
  id: Number(r.id),
  nit: String(r.nit_proveedor),
  codigoTransaccion: String(r.codigo_transaccion),
  documento: Number(r.documento),
  fechaPago: iso(r.fecha_pago),
  forma: r.forma as FormaPago,
  valor: n(r.valor),
  salda: Boolean(r.salda),
  referencia: (r.referencia as string | null) ?? null,
  observacion: (r.observacion as string | null) ?? null,
  registradoPor: String(r.registrado_por),
  registradoEn: new Date(r.registrado_en as string | Date).toISOString(),
});

/** Pagos vigentes de un laboratorio, del más reciente al más viejo. */
export async function readPagosLab(nit: string): Promise<PagoDd[]> {
  if (!(await tablaPagosExiste())) return [];
  const sql = getDb();
  const filas = (await sql`
    SELECT id, nit_proveedor, codigo_transaccion, documento, fecha_pago, forma, valor, salda,
           referencia, observacion, registrado_por, registrado_en
      FROM dd_pago
     WHERE anulado_en IS NULL AND nit_proveedor = ${nit}
     ORDER BY fecha_pago DESC, id DESC
  `) as unknown as Array<Record<string, unknown>>;
  return filas.map(aPago);
}

/** ¿Existe esa factura con precio cero de ese laboratorio? (cualquier fecha) */
export async function existeFacturaP0(nit: string, codigoTransaccion: string, documento: number): Promise<boolean> {
  await verificarTablas();
  const sql = getDb();
  const [r] = (await sql`
    SELECT EXISTS (
      SELECT 1 FROM dd_linea
       WHERE fuente = 'venta' AND tipo = 'venta_precio_cero' AND nit_proveedor = ${nit}
         AND codigo_transaccion = ${codigoTransaccion} AND documento = ${documento}
    ) AS existe
  `) as unknown as Array<{ existe: boolean }>;
  return r.existe;
}

export async function insertarPago(p: PagoNuevo, email: string): Promise<PagoDd> {
  await exigirTablaPagos();
  const sql = getDb();
  const [r] = (await sql`
    INSERT INTO dd_pago (nit_proveedor, codigo_transaccion, documento, fecha_pago, forma, valor, salda,
                         referencia, observacion, registrado_por)
    VALUES (${p.nit}, ${p.codigoTransaccion}, ${p.documento}, ${p.fechaPago}, ${p.forma}, ${p.valor}, ${p.salda},
            ${p.referencia}, ${p.observacion}, ${email})
    RETURNING id, nit_proveedor, codigo_transaccion, documento, fecha_pago, forma, valor, salda,
              referencia, observacion, registrado_por, registrado_en
  `) as unknown as Array<Record<string, unknown>>;
  return aPago(r);
}

/** Anula (no borra) un pago vigente. Devuelve false si no existía o ya estaba anulado. */
export async function anularPago(id: number, email: string): Promise<boolean> {
  await exigirTablaPagos();
  const sql = getDb();
  const filas = (await sql`
    UPDATE dd_pago SET anulado_en = NOW(), anulado_por = ${email}
     WHERE id = ${id} AND anulado_en IS NULL
    RETURNING id
  `) as unknown as unknown[];
  return filas.length > 0;
}
