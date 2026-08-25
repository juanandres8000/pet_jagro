import { getSql as getDb } from '../pg';
import { ensureMovimientoTables, type Ventana } from './pygIngest';

/**
 * Lecturas del P&G sobre pyg_movimiento / pyg_ventana_control / pyg_mensual.
 *
 * Todas las consultas van EN SERIE desde los llamadores: el cliente de Postgres
 * es `max: 1` y un Promise.all sobre él cuelga la ruta hasta el timeout
 * (CLAUDE.md § Trampas del pooler #2).
 */

/** Primer mes con movimiento contable disponible para el P&G. */
export const PYG_MES_INICIO = '2026-01';

// ------------------------------------------------------- helpers de fecha --

/** Último día del mes 'YYYY-MM' como 'YYYY-MM-DD'. No depende de la zona horaria. */
export function finDeMes(mes: string): string {
  const [y, m] = mes.split('-').map(Number);
  return `${mes}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

/** Días que tiene el mes 'YYYY-MM'. */
export function diasDelMes(mes: string): number {
  const [y, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Ventana mensual completa de 'YYYY-MM'. */
export const ventanaDeMes = (mes: string): Ventana => ({ desde: `${mes}-01`, hasta: finDeMes(mes) });

/** Desplaza un mes 'YYYY-MM' en n meses (n puede ser negativo). */
export function desplazarMes(mes: string, n: number): string {
  const [y, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Desplaza un día 'YYYY-MM-DD' en n días. */
export function desplazarDia(dia: string, n: number): string {
  return new Date(Date.parse(`${dia}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Meses cerrados desde PYG_MES_INICIO hasta el anterior a `hoy`, del más nuevo al más viejo. */
export function mesesCerrados(hoy: string): string[] {
  const actual = hoy.slice(0, 7);
  const out: string[] = [];
  let m = desplazarMes(actual, -1);
  while (m >= PYG_MES_INICIO) {
    out.push(m);
    m = desplazarMes(m, -1);
  }
  return out;
}

// ------------------------------------------------------------- control ----

export interface FilaControl {
  desde: string;
  hasta: string;
  estado: string;
  lineas: number;
  intentos: number;
  ultimoError: string | null;
  actualizadoEn: Date;
}

const toControl = (r: {
  ventana_desde: string;
  ventana_hasta: string;
  estado: string;
  lineas: number;
  intentos: number;
  ultimo_error: string | null;
  actualizado_en: string | Date;
}): FilaControl => ({
  desde: String(r.ventana_desde).slice(0, 10),
  hasta: String(r.ventana_hasta).slice(0, 10),
  estado: r.estado,
  lineas: r.lineas,
  intentos: r.intentos,
  ultimoError: r.ultimo_error,
  actualizadoEn: new Date(r.actualizado_en),
});

/** Todas las ventanas registradas. Liviano: no toca pyg_movimiento. */
export async function readControl(): Promise<FilaControl[]> {
  await ensureMovimientoTables();
  const sql = getDb();
  const rows = (await sql`
    SELECT ventana_desde::text AS ventana_desde, ventana_hasta::text AS ventana_hasta,
           estado, lineas, intentos, ultimo_error, actualizado_en
      FROM pyg_ventana_control
     ORDER BY ventana_desde
  `) as unknown as Parameters<typeof toControl>[0][];
  return rows.map(toControl);
}

/** Control de las ventanas de UN día dentro de un rango, para elegir cursor. */
export async function readControlDias(desde: string, hasta: string): Promise<FilaControl[]> {
  await ensureMovimientoTables();
  const sql = getDb();
  const rows = (await sql`
    SELECT ventana_desde::text AS ventana_desde, ventana_hasta::text AS ventana_hasta,
           estado, lineas, intentos, ultimo_error, actualizado_en
      FROM pyg_ventana_control
     WHERE ventana_desde = ventana_hasta
       AND ventana_desde BETWEEN ${desde} AND ${hasta}
  `) as unknown as Parameters<typeof toControl>[0][];
  return rows.map(toControl);
}

/** Meses cuya VENTANA MENSUAL completa está en estado ok, del más nuevo al más viejo. */
export async function readMesesMensualOk(limite = 12): Promise<string[]> {
  await ensureMovimientoTables();
  const sql = getDb();
  const rows = (await sql`
    SELECT to_char(ventana_desde, 'YYYY-MM') AS mes
      FROM pyg_ventana_control
     WHERE estado = 'ok'
       AND ventana_desde = date_trunc('month', ventana_desde)::date
       AND ventana_hasta = (date_trunc('month', ventana_desde) + interval '1 month - 1 day')::date
     ORDER BY ventana_desde DESC
     LIMIT ${limite}
  `) as unknown as Array<{ mes: string }>;
  return rows.map((r) => r.mes);
}

/**
 * Días del mes cubiertos por ALGUNA ventana en estado ok.
 *
 * Una ventana mensual cubre los 30 o 31 días de un golpe; las ventanas de un día
 * cubren uno cada una. Se expande cada ventana a sus días y se cuenta la unión,
 * para que las dos granularidades se sumen sin contar doble.
 */
export async function readDiasCubiertos(mes: string): Promise<number> {
  await ensureMovimientoTables();
  const sql = getDb();
  const rows = (await sql`
    SELECT count(DISTINCT g.d::date)::int AS dias
      FROM pyg_ventana_control c
      CROSS JOIN LATERAL generate_series(c.ventana_desde, c.ventana_hasta, interval '1 day') AS g(d)
     WHERE c.estado = 'ok'
       AND to_char(g.d, 'YYYY-MM') = ${mes}
  `) as unknown as Array<{ dias: number }>;
  return rows[0]?.dias ?? 0;
}

// ------------------------------------------------------------- P&G --------

export interface PygMes {
  mes: string;
  ventasBrutas: number;
  devolucionesDescuentos: number;
  ingOperacionalNeto: number;
  ingNoOperacional: number;
  ingresosTotales: number;
  costoContable: number;
  costo: number;
  costoEsFallback: boolean;
  gastoAdmon: number;
  gastoVentas: number;
  gastoNoOperacional: number;
  gastoTotal: number;
  utilidadBruta: number;
  resultado: number;
  debitosMes: number;
  creditosMes: number;
  cuadraPartidaDoble: boolean;
}

const n = (v: unknown): number => Number(v ?? 0);

/** Encabezado del P&G de un mes, o null si no hay movimiento cargado. */
export async function readPygMes(mes: string): Promise<PygMes | null> {
  await ensureMovimientoTables();
  const sql = getDb();
  const rows = (await sql`SELECT * FROM pyg_mensual WHERE mes = ${mes}`) as unknown as Array<
    Record<string, unknown>
  >;
  const r = rows[0];
  if (!r) return null;
  return {
    mes: String(r.mes),
    ventasBrutas: n(r.ventas_brutas),
    devolucionesDescuentos: n(r.devoluciones_descuentos),
    ingOperacionalNeto: n(r.ing_operacional_neto),
    ingNoOperacional: n(r.ing_no_operacional),
    ingresosTotales: n(r.ingresos_totales),
    costoContable: n(r.costo_contable),
    costo: n(r.costo),
    costoEsFallback: !!r.costo_es_fallback,
    gastoAdmon: n(r.gasto_admon),
    gastoVentas: n(r.gasto_ventas),
    gastoNoOperacional: n(r.gasto_no_operacional),
    gastoTotal: n(r.gasto_total),
    utilidadBruta: n(r.utilidad_bruta),
    resultado: n(r.resultado),
    debitosMes: n(r.debitos_mes),
    creditosMes: n(r.creditos_mes),
    cuadraPartidaDoble: !!r.cuadra_partida_doble,
  };
}

export interface SubcuentaGasto {
  subcuenta: string;
  descripcion: string;
  saldo: number;
  lineas: number;
}
export interface GrupoGasto {
  grupo: string;
  descripcion: string;
  saldo: number;
  subcuentas: SubcuentaGasto[];
}

/** Gastos (clase 5) de un mes, por grupo y expandidos a subcuenta de 6 dígitos. */
export async function readGastosPorGrupo(mes: string): Promise<GrupoGasto[]> {
  await ensureMovimientoTables();
  const sql = getDb();
  // Una sola pasada al nivel de subcuenta; el grupo se arma en memoria para no
  // emitir dos queries sobre la conexión única.
  const rows = (await sql`
    SELECT s.grupo,
           COALESCE(g.descripcion, '') AS grupo_descripcion,
           s.subcuenta,
           COALESCE(sc.descripcion, min(s.descripcion)) AS descripcion,
           sum(s.saldo)::float8 AS saldo,
           sum(s.lineas)::int AS lineas
      FROM pyg_saldo_cuenta s
      LEFT JOIN pyg_cuenta g  ON g.cuenta = s.grupo
      LEFT JOIN pyg_cuenta sc ON sc.cuenta = s.subcuenta
     WHERE s.mes = ${mes} AND s.clase = '5'
     GROUP BY s.grupo, g.descripcion, s.subcuenta, sc.descripcion
     ORDER BY s.grupo, sum(s.saldo) DESC
  `) as unknown as Array<{
    grupo: string;
    grupo_descripcion: string;
    subcuenta: string;
    descripcion: string;
    saldo: number;
    lineas: number;
  }>;

  const porGrupo = new Map<string, GrupoGasto>();
  for (const r of rows) {
    let g = porGrupo.get(r.grupo);
    if (!g) {
      g = { grupo: r.grupo, descripcion: r.grupo_descripcion, saldo: 0, subcuentas: [] };
      porGrupo.set(r.grupo, g);
    }
    g.saldo += r.saldo;
    g.subcuentas.push({
      subcuenta: r.subcuenta,
      descripcion: r.descripcion,
      saldo: r.saldo,
      lineas: r.lineas,
    });
  }
  return [...porGrupo.values()];
}

export interface AsientoCosto {
  comprobante: string;
  documento: number;
  fecha: string;
  detalle: string;
  debito: number;
  credito: number;
}

/**
 * El asiento de costo de ventas (6135) del mes, para poder citarlo en el aviso
 * cuando está en cero. Medido: comprobante 27, docs 76=abril 77=mayo 78=junio
 * 79=julio, glosa "COSTO DE VENTA <MES>", todos salvo abril con débito 0.
 */
export async function readAsientoCosto(mes: string): Promise<AsientoCosto | null> {
  await ensureMovimientoTables();
  const sql = getDb();
  const rows = (await sql`
    SELECT id_comprobante, documento, fecha::text AS fecha, detalle,
           sum(debito)::float8 AS debito, sum(credito)::float8 AS credito
      FROM pyg_movimiento
     WHERE mes = ${mes} AND cuenta LIKE '6135%' AND periodo <> 13
     GROUP BY id_comprobante, documento, fecha, detalle
     ORDER BY sum(debito) DESC, documento
     LIMIT 1
  `) as unknown as Array<{
    id_comprobante: string;
    documento: number;
    fecha: string;
    detalle: string | null;
    debito: number;
    credito: number;
  }>;
  const r = rows[0];
  if (!r) return null;
  return {
    comprobante: r.id_comprobante,
    documento: r.documento,
    fecha: r.fecha,
    detalle: r.detalle ?? '',
    debito: r.debito,
    credito: r.credito,
  };
}

/** Meses de los últimos `n` con la ventana mensual ok y costo contable en cero. */
export async function readMesesSinCostoValorizado(limite = 12): Promise<string[]> {
  await ensureMovimientoTables();
  const sql = getDb();
  const rows = (await sql`
    SELECT m.mes
      FROM pyg_mensual m
     WHERE m.costo_contable = 0
       AND EXISTS (
         SELECT 1 FROM pyg_ventana_control c
          WHERE c.estado = 'ok'
            AND c.ventana_desde = (m.mes || '-01')::date
            AND c.ventana_hasta = (date_trunc('month', (m.mes || '-01')::date) + interval '1 month - 1 day')::date
       )
     ORDER BY m.mes DESC
     LIMIT ${limite}
  `) as unknown as Array<{ mes: string }>;
  return rows.map((r) => r.mes);
}

/** Varios encabezados de una sola query, para el listado sin `mes`. */
export async function readPygMeses(meses: string[]): Promise<PygMes[]> {
  if (meses.length === 0) return [];
  await ensureMovimientoTables();
  const sql = getDb();
  const rows = (await sql`
    SELECT * FROM pyg_mensual WHERE mes = ANY(${meses}) ORDER BY mes DESC
  `) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    mes: String(r.mes),
    ventasBrutas: n(r.ventas_brutas),
    devolucionesDescuentos: n(r.devoluciones_descuentos),
    ingOperacionalNeto: n(r.ing_operacional_neto),
    ingNoOperacional: n(r.ing_no_operacional),
    ingresosTotales: n(r.ingresos_totales),
    costoContable: n(r.costo_contable),
    costo: n(r.costo),
    costoEsFallback: !!r.costo_es_fallback,
    gastoAdmon: n(r.gasto_admon),
    gastoVentas: n(r.gasto_ventas),
    gastoNoOperacional: n(r.gasto_no_operacional),
    gastoTotal: n(r.gasto_total),
    utilidadBruta: n(r.utilidad_bruta),
    resultado: n(r.resultado),
    debitosMes: n(r.debitos_mes),
    creditosMes: n(r.creditos_mes),
    cuadraPartidaDoble: !!r.cuadra_partida_doble,
  }));
}

/** Días cubiertos por ventanas ok para VARIOS meses, en una sola query. */
export async function readDiasCubiertosVarios(meses: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (meses.length === 0) return out;
  await ensureMovimientoTables();
  const sql = getDb();
  const rows = (await sql`
    SELECT to_char(g.d, 'YYYY-MM') AS mes, count(DISTINCT g.d::date)::int AS dias
      FROM pyg_ventana_control c
      CROSS JOIN LATERAL generate_series(c.ventana_desde, c.ventana_hasta, interval '1 day') AS g(d)
     WHERE c.estado = 'ok'
       AND to_char(g.d, 'YYYY-MM') = ANY(${meses})
     GROUP BY 1
  `) as unknown as Array<{ mes: string; dias: number }>;
  for (const r of rows) out.set(r.mes, r.dias);
  return out;
}

/** ¿Existe una ventana MENSUAL completa en estado ok para este mes? */
export async function tieneVentanaMensualOk(mes: string): Promise<boolean> {
  await ensureMovimientoTables();
  const sql = getDb();
  const rows = (await sql`
    SELECT 1 FROM pyg_ventana_control
     WHERE estado = 'ok' AND ventana_desde = ${`${mes}-01`} AND ventana_hasta = ${finDeMes(mes)}
     LIMIT 1
  `) as unknown as Array<unknown>;
  return rows.length > 0;
}
