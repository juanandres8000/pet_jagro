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

async function traerDetalle(
  desde: string,
  hasta: string,
  transaccion: string,
  tipoDocumento: '0' | '1',
  traer: HgiFetch,
): Promise<HgiDetalleLinea[]> {
  let ultimo: Error | null = null;
  for (let intento = 0; intento < REINTENTOS; intento++) {
    if (intento > 0) await sleep(BACKOFF_BASE_MS * 2 ** (intento - 1));
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

/** Deja una línea por Id y sólo las fechadas dentro de la ventana. */
function depurar(filas: HgiDetalleLinea[], v: Ventana): { filas: HgiDetalleLinea[]; fuera: number } {
  const porId = new Map<string, HgiDetalleLinea>();
  let fuera = 0;
  for (const f of filas) {
    const fecha = String(f.Fecha ?? '').slice(0, 10);
    if (fecha < v.desde || fecha > v.hasta) {
      fuera++;
      continue;
    }
    // Sin Id no hay llave: se conserva (aLineaDd la contará como descartada).
    porId.set(f.Id === undefined || f.Id === null ? `sin-id-${porId.size}` : String(f.Id), f);
  }
  return { filas: [...porId.values()], fuera };
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
  duracionMs: number;
}

export async function ingestarVentana(v: Ventana, traer: HgiFetch = hgiFetchPorDefecto): Promise<ResultadoIngestaDd> {
  const lote = randomUUID();
  const t0 = Date.now();
  await marcarIntento(v, lote);

  try {
    const ventasCrudas: HgiDetalleLinea[] = [];
    for (const r of trocear(v)) {
      ventasCrudas.push(...(await traerDetalle(r.desde, r.hasta, '*', '1', traer)));
      await sleep(PAUSA_MS);
    }
    const ventas = depurar(ventasCrudas, v);
    ventasCrudas.length = 0;
    const cv = clasificarVentas(ventas.filas);

    const compras: LineaDd[] = [];
    let fueraCompras = 0;
    let descartadasCompras = 0;
    for (const tr of Object.keys(TRANSACCIONES_COMPRA)) {
      const d = depurar(await traerDetalle(v.desde, v.hasta, tr, '0', traer), v);
      fueraCompras += d.fuera;
      const c = clasificarCompras(d.filas, tr);
      descartadasCompras += c.descartadas;
      compras.push(...c.lineas);
      await sleep(PAUSA_MS);
    }

    const descartadas = cv.descartadas + descartadasCompras;
    // Una línea sin Id/fecha/documento rompería la idempotencia: mejor fallar la
    // ventana (queda en error y se reintenta) que guardar un mes incompleto.
    if (descartadas > 0) throw new Error(`${descartadas} líneas sin Id/fecha/documento: ventana no guardada`);

    const lineas = [...cv.lineas, ...compras];
    const duracionMs = Date.now() - t0;
    const { borradas } = await escribirVentana(v, lote, {
      lineas,
      agregados: cv.agregados,
      lineasVenta: cv.lineasLeidas,
      lineasCompra: compras.length,
      docsPrecioCero: cv.docsPrecioCero,
      duracionMs,
    });

    return {
      ventana: v,
      lineasVenta: cv.lineasLeidas,
      docsPrecioCero: cv.docsPrecioCero,
      lineasCompra: compras.length,
      guardadas: lineas.length,
      borradas,
      fueraVentana: ventas.fuera + fueraCompras,
      descartadas,
      duracionMs: Date.now() - t0,
    };
  } catch (err) {
    await marcarError(v, (err as Error).message, Date.now() - t0);
    throw err;
  }
}
