import { randomUUID } from 'node:crypto';
import { trocear } from '../ventas';
import { hgiFetchPorDefecto, type HgiFetch } from '../pygFetch';
import {
  TRANSACCIONES_COMPRA,
  clasificarCompras,
  clasificarVentas,
  type HgiDetalleLinea,
  type LineaDd,
} from './mappers';
import { escribirVentana, marcarError, marcarIntento, type Ventana } from './store';

/**
 * Ingesta de UNA ventana mensual del módulo de descuentos.
 *
 * Fuente única: Api/Documentos/ObtenerDetalleReporte (sólo lectura).
 *  - Ventas: tipo_documento=1 y codigo_transaccion='*', en trozos de 5 días como
 *    lib/hgi/ventas.ts (rangos largos se pasan del timeout).
 *  - Compras: tipo_documento=0 y codigo_transaccion EXPLÍCITO (40, 45, 33, 32, 05).
 *    Con '*' y tipo 0 HGINet devuelve pedidos/cotizaciones, no compras; con el
 *    código explícito devuelve el detalle de compra (verificado 27-oct-2026:
 *    1–10 ago, 507 líneas de la 40 y 15 de la 45). Un mes de compras es ~2 s.
 *
 * Concurrencia 1 y pausa entre llamadas: este cron no debe competir con los de
 * Gerencia ni del P&G por HGINet.
 *
 * Las líneas cuya `Fecha` cae fuera de la ventana (spillover) se DESCARTAN aquí:
 * pertenecen a la ventana de su mes, que las trae sola. Sin esto el agregado de
 * venta contaría dos veces la misma línea.
 */

const TIMEOUT_MS = 60_000;
const REINTENTOS = 3;
const BACKOFF_BASE_MS = 1500;
const PAUSA_MS = 400;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Parámetros en ORDEN EXACTO (routing por firma de WebAPI; ver ventas.ts). */
const params = (desde: string, hasta: string, transaccion: string, tipoDocumento: '0' | '1') => ({
  codigo_empresa: '*',
  codigo_transaccion: transaccion,
  documento: '*',
  codigo_tercero: '*',
  codigo_vendedor: '*',
  codigo_local: '*',
  fecha_inicial: desde,
  fecha_final: hasta,
  codigo_producto: '*',
  tipo_documento: tipoDocumento,
});

/**
 * Fin del presupuesto: se comprueba antes de CADA llamada y de cada reintento. Si
 * Vercel matara el lambda a mitad de ventana, marcarError no correría y la ventana
 * quedaría 'pendiente'; cortando aquí, el error queda registrado y se reintenta.
 */
class PresupuestoAgotado extends Error {}
function exigirTiempo(deadline: number) {
  // Tiene que caber una llamada COMPLETA (hasta TIMEOUT_MS) antes del límite.
  if (Date.now() + TIMEOUT_MS > deadline) throw new PresupuestoAgotado('Presupuesto de la corrida agotado a mitad de ventana; se reintenta en la próxima');
}

async function traerDetalle(
  desde: string,
  hasta: string,
  transaccion: string,
  tipoDocumento: '0' | '1',
  traer: HgiFetch,
  deadline: number,
): Promise<HgiDetalleLinea[]> {
  let ultimo: Error | null = null;
  for (let intento = 0; intento < REINTENTOS; intento++) {
    if (intento > 0) await sleep(BACKOFF_BASE_MS * 2 ** (intento - 1));
    exigirTiempo(deadline);
    try {
      const raw = await traer<HgiDetalleLinea[]>(
        'Documentos',
        'ObtenerDetalleReporte',
        params(desde, hasta, transaccion, tipoDocumento),
        { timeoutMs: TIMEOUT_MS },
      );
      if (!Array.isArray(raw)) throw new Error('ObtenerDetalleReporte no devolvió un array');
      return raw;
    } catch (err) {
      ultimo = err as Error;
    }
  }
  throw new Error(`Detalle ${transaccion}/${tipoDocumento} ${desde}..${hasta} falló tras ${REINTENTOS} intentos: ${ultimo?.message}`);
}

const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Deja una línea por Id y sólo las fechadas dentro de la ventana.
 *  - Fecha ilegible: NO es "fuera de ventana" (eso sería descartarla en silencio);
 *    cuenta como inválida y hace fallar la ventana.
 *  - Id repetido en la respuesta: se cuenta. Medido en ago–sep 2026: 0 repetidos
 *    en 45.601 líneas de ventas y compras.
 */
function depurar(filas: HgiDetalleLinea[], v: Ventana): { filas: HgiDetalleLinea[]; fuera: number; invalidas: number; repetidas: number } {
  const porId = new Map<string, HgiDetalleLinea>();
  let fuera = 0;
  let invalidas = 0;
  let repetidas = 0;
  for (const f of filas) {
    const fecha = String(f.Fecha ?? '').slice(0, 10);
    if (!FECHA_ISO.test(fecha)) {
      invalidas++;
      continue;
    }
    if (fecha < v.desde || fecha > v.hasta) {
      fuera++;
      continue;
    }
    if (f.Id === undefined || f.Id === null || f.Id === '') {
      invalidas++;
      continue;
    }
    const k = String(f.Id);
    if (porId.has(k)) repetidas++;
    porId.set(k, f);
  }
  return { filas: [...porId.values()], fuera, invalidas, repetidas };
}

export interface ResultadoIngestaDd {
  ventana: Ventana;
  lineasVenta: number;
  docsPrecioCero: number;
  lineasCompra: number;
  guardadas: number;
  borradas: number;
  fueraVentana: number;
  descartadas: number;
  repetidas: number;
  duracionMs: number;
}

/** `deadline` (epoch ms): la ventana falla limpia si no termina antes. Sin él, 10 min. */
export async function ingestarVentana(
  v: Ventana,
  traer: HgiFetch = hgiFetchPorDefecto,
  deadline: number = Date.now() + 600_000,
): Promise<ResultadoIngestaDd> {
  const lote = randomUUID();
  const t0 = Date.now();
  await marcarIntento(v, lote);

  try {
    const ventasCrudas: HgiDetalleLinea[] = [];
    for (const r of trocear(v)) {
      ventasCrudas.push(...(await traerDetalle(r.desde, r.hasta, '*', '1', traer, deadline)));
      await sleep(PAUSA_MS);
    }
    const leidasVenta = ventasCrudas.length;
    const ventas = depurar(ventasCrudas, v);
    ventasCrudas.length = 0;
    const cv = clasificarVentas(ventas.filas);

    const compras: LineaDd[] = [];
    let fueraCompras = 0;
    let descartadasCompras = 0;
    let repetidasCompras = 0;
    for (const tr of Object.keys(TRANSACCIONES_COMPRA)) {
      const d = depurar(await traerDetalle(v.desde, v.hasta, tr, '0', traer, deadline), v);
      fueraCompras += d.fuera;
      descartadasCompras += d.invalidas;
      repetidasCompras += d.repetidas;
      const c = clasificarCompras(d.filas, tr);
      descartadasCompras += c.descartadas;
      compras.push(...c.lineas);
      await sleep(PAUSA_MS);
    }

    const descartadas = cv.descartadas + ventas.invalidas + descartadasCompras;
    // Una línea sin Id/fecha/documento rompería la idempotencia: mejor fallar la
    // ventana (queda en error y se reintenta) que guardar un mes incompleto.
    if (descartadas > 0) throw new Error(`${descartadas} líneas sin Id/fecha/documento: ventana no guardada`);

    const lineas = [...cv.lineas, ...compras];
    // dd_linea.id es PK global: un Id que apareciera en ventas Y compras haría que
    // una fila pisara a la otra. No ocurre en los datos medidos; si ocurre, se falla.
    const idsVenta = new Set(cv.lineas.map((l) => l.id));
    const cruzados = compras.filter((l) => idsVenta.has(l.id)).length;
    if (cruzados > 0) throw new Error(`${cruzados} Id de línea repetidos entre ventas y compras: ventana no guardada`);
    const duracionMs = Date.now() - t0;
    const { borradas } = await escribirVentana(v, lote, {
      lineas,
      agregados: cv.agregados,
      lineasVenta: leidasVenta,
      lineasCompra: compras.length,
      docsPrecioCero: cv.docsPrecioCero,
      duracionMs,
    });

    return {
      ventana: v,
      lineasVenta: leidasVenta,
      docsPrecioCero: cv.docsPrecioCero,
      lineasCompra: compras.length,
      guardadas: lineas.length,
      borradas,
      fueraVentana: ventas.fuera + fueraCompras,
      descartadas,
      repetidas: ventas.repetidas + repetidasCompras,
      duracionMs: Date.now() - t0,
    };
  } catch (err) {
    await marcarError(v, (err as Error).message, Date.now() - t0);
    throw err;
  }
}
