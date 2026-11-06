import { randomUUID } from 'node:crypto';
import { trocear } from '../ventas';
import { hgiFetchPorDefecto, type HgiFetch } from '../pygFetch';
import { depurar, PAUSA_MS, sleep, traerDetalle } from '../descuentos/ingest';
import { ventanaDeMes, mesesHasta, elegirVentanas } from '../descuentos/refresh';
import type { Ventana } from '../descuentos/store';
import { hoyColombia } from '../ventas';
import { agregarMovimientos, agregarSaldos, TRANSACCIONES_TIPO0, type HgiSaldoInv } from './mappers';
import { escribirVentanaRot, guardarSaldos, marcarErrorRot, marcarIntentoRot, readControlRot } from './store';

/**
 * Ingesta de la rotación de inventario (docs/ROTACION.md). Sólo lectura en HGINet.
 *  - Ventas y notas crédito: ObtenerDetalleReporte tipo_documento=1 '*', trozos de 5 días.
 *  - Compras, traslados, ajustes, bonificados, préstamos, deterioro: tipo_documento=0
 *    con código explícito (TRANSACCIONES_TIPO0). Con '*' HGINet devuelve pedidos.
 *  - Existencias: Inventario/ObtenerInventario (una llamada, ~4.400 filas).
 */

/**
 * Transacciones que pueden llegar en la consulta de ventas y NO mueven unidades:
 * notas por descuento (94), notas débito clientes (44), pedidos, cotizaciones y
 * sus cancelaciones, y las de pruebas DIAN. Validado: el informe de HGI cuadra sin ellas.
 */
const SIN_INVENTARIO = new Set(['94', '44', '09', '10', '26', '46', '58', '61', '63', '64', '65', '91', '92', '93']);

export interface ResultadoVentanaRot {
  mes: string;
  lineas: number;
  filas: number;
  borradas: number;
  fueraVentana: number;
  duracionMs: number;
}

export async function ingestarVentanaRot(
  v: Ventana,
  traer: HgiFetch = hgiFetchPorDefecto,
  deadline: number = Date.now() + 600_000,
): Promise<ResultadoVentanaRot> {
  const lote = randomUUID();
  const t0 = Date.now();
  await marcarIntentoRot(v, lote);
  try {
    const crudas = [];
    for (const r of trocear(v)) {
      crudas.push(...(await traerDetalle(r.desde, r.hasta, '*', '1', traer, deadline)));
      await sleep(PAUSA_MS);
    }
    for (const tr of TRANSACCIONES_TIPO0) {
      crudas.push(...(await traerDetalle(v.desde, v.hasta, tr, '0', traer, deadline)));
      await sleep(PAUSA_MS);
    }
    const d = depurar(crudas, v);
    if (d.invalidas > 0) throw new Error(`${d.invalidas} líneas sin fecha legible: ventana no guardada`);
    const a = agregarMovimientos(d.filas);
    // Un código que mueve inventario y no está mapeado haría cuadrar mal en silencio.
    const desconocidos = Object.entries(a.sinMapa).filter(([c]) => !SIN_INVENTARIO.has(c));
    if (desconocidos.length) {
      throw new Error(`Transacciones sin clasificar en rotación: ${desconocidos.map(([c, k]) => `${c} (${k})`).join(', ')}`);
    }
    const duracionMs = Date.now() - t0;
    const { borradas } = await escribirVentanaRot(v, lote, a.filas, [...a.productos.values()], d.filas.length, duracionMs);
    return { mes: v.desde.slice(0, 7), lineas: d.filas.length, filas: a.filas.length, borradas, fueraVentana: d.fuera, duracionMs: Date.now() - t0 };
  } catch (err) {
    await marcarErrorRot(v, (err as Error).message, Date.now() - t0);
    throw err;
  }
}

/** Toma la foto de existencias actual de HGINet y la reemplaza en rot_saldo. */
export async function tomarSaldos(traer: HgiFetch = hgiFetchPorDefecto): Promise<number> {
  const raw = await traer<HgiSaldoInv[]>(
    'Inventario',
    'ObtenerInventario',
    { codigo_producto: '*', codigo_bodega: '*', codigo_lote: '*' },
    { timeoutMs: 60_000 },
  );
  if (!Array.isArray(raw)) throw new Error('Inventario/ObtenerInventario no devolvió un array');
  const saldos = agregarSaldos(raw);
  await guardarSaldos(saldos, new Date());
  return saldos.length;
}

// ------------------------------------------------------------ orquestación ---

/** Primer mes del histórico (los periodos no pueden empezar antes). */
export const MES_INICIAL_ROT = '2026-01';
const FRACCION_PRESUPUESTO = 0.8;
const FRACCION_LIMITE = 0.95;
/** Una ventana mensual: ~6 trozos de ventas + 17 transacciones. Medido: 60–110 s. */
const ESTIMADO_VENTANA_MS = 130_000;

export interface ResultadoRefreshRot {
  dataset: 'rotacion';
  ventanas: Array<ResultadoVentanaRot & { motivo: string }>;
  errores: Array<{ mes: string; error: string }>;
  saldos: number | null;
  pendientes: number;
}

/**
 * Corre ventanas mensuales hasta agotar el presupuesto (mismo criterio que
 * descuentos: meses vivos, luego los nunca ingestados del más nuevo al más viejo,
 * luego reintentos). Si se refrescó el mes en curso, toma la foto de existencias
 * JUSTO después: inicial y final se calculan hacia atrás desde ese saldo, así que
 * saldo y movimiento del mes en curso deben ser de la misma hora.
 */
export async function refreshRotacion(maxDurationS: number, mes?: string): Promise<ResultadoRefreshRot> {
  const t0 = Date.now();
  const presupuesto = maxDurationS * 1000 * FRACCION_PRESUPUESTO;
  const hoy = hoyColombia();
  const actual = hoy.slice(0, 7);
  let cola: Array<{ mes: string; motivo: string }>;
  if (mes) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes) || mes > actual || mes < MES_INICIAL_ROT) throw new Error(`mes inválido: ${mes}`);
    cola = [{ mes, motivo: 'forzado (?mes=)' }];
  } else {
    cola = elegirVentanas(await readControlRot(), hoy, Date.now()).filter((c) => c.mes >= MES_INICIAL_ROT);
  }

  const ventanas: ResultadoRefreshRot['ventanas'] = [];
  const errores: ResultadoRefreshRot['errores'] = [];
  let saldos: number | null = null;
  let i = 0;
  for (; i < cola.length; i++) {
    if (Date.now() - t0 + ESTIMADO_VENTANA_MS > presupuesto) break;
    const { mes: m, motivo } = cola[i];
    console.log(`[rotacion] ventana ${m} — ${motivo}`);
    try {
      const r = await ingestarVentanaRot(ventanaDeMes(m), undefined, t0 + maxDurationS * 1000 * FRACCION_LIMITE);
      console.log(`[rotacion] ${m} ok: ${r.lineas} líneas, ${r.filas} filas, ${(r.duracionMs / 1000).toFixed(1)}s`);
      ventanas.push({ ...r, motivo });
      if (m === actual) {
        saldos = await tomarSaldos();
        console.log(`[rotacion] existencias: ${saldos} filas`);
      }
    } catch (err) {
      console.error(`[rotacion] ${m} error:`, (err as Error).message);
      errores.push({ mes: m, error: (err as Error).message });
    }
  }
  return { dataset: 'rotacion', ventanas, errores, saldos, pendientes: cola.length - i };
}

export { mesesHasta };
