import { hgiGet, HgiError, getValidToken } from './client';
import {
  mapVentas,
  aggregateVentas,
  type HgiVentaLinea,
  type VentaLinea,
  type VentasResumen,
} from './mappers/ventas';
import type { BuildResult } from './readThrough';

/**
 * Construcción del dataset de Ventas contra HGINet.
 * Método real verificado: Api/Documentos/ObtenerDetalleReporte con
 * tipo_documento=1 (facturas + notas crédito).
 *
 * Reglas NO obvias (validadas en vivo, no re-descubrir):
 *  - El ORDEN de los parámetros importa: el routing de WebAPI es por firma
 *    exacta. Con otro orden o un parámetro de menos responde 404 con el mismo
 *    mensaje genérico que un método inexistente. Por eso se construyen como
 *    array de pares y no como objeto.
 *  - tipo_documento=1 son ventas; 0 son pedidos/cotizaciones; 2 y 3 vienen
 *    vacíos. Nunca usar 0 aquí: mezclaría pedidos con facturas.
 *  - El endpoint aguanta mal los rangos largos: 23 días tardan 40-120s y se
 *    pasan del timeout. Se pagina en ventanas de 5 días.
 *  - El reintento con backoff cubre fallos transitorios de red/timeout. Ojo con
 *    los HTTP 400 de cuerpo vacío: NO son rate-limiting sino token caducado, y
 *    reintentar con el mismo token no los recupera (ver nota en el cliente).
 */

const VENTAS_TIMEOUT_MS = 60_000;
const DIAS_POR_VENTANA = 5;
const CONCURRENCIA = 2;
const REINTENTOS = 3;
const BACKOFF_BASE_MS = 1500;
// Respiro entre llamadas. HGINet no limita por ritmo (ver nota arriba), pero
// el mes completo se resuelve en ~18s igualmente y no vale la pena apretar.
const PAUSA_MS = 400;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Colombia es UTC-5 permanente (sin horario de verano).
const TZ_OFFSET_MS = 5 * 60 * 60 * 1000;

/** "Hoy" en hora de Colombia, como YYYY-MM-DD. */
export function hoyColombia(): string {
  return new Date(Date.now() - TZ_OFFSET_MS).toISOString().slice(0, 10);
}

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Último día del mes (m es 1..12). */
const ultimoDia = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export interface Rango {
  desde: string;
  hasta: string;
}

/** Mes corriente (día 1 → hoy) y mes anterior completo, en hora de Colombia. */
export function ventanas(hoy = hoyColombia()): { actual: Rango; anterior: Rango } {
  const [y, m] = hoy.split('-').map(Number);
  const yAnt = m === 1 ? y - 1 : y;
  const mAnt = m === 1 ? 12 : m - 1;
  return {
    actual: { desde: iso(y, m, 1), hasta: hoy },
    anterior: { desde: iso(yAnt, mAnt, 1), hasta: iso(yAnt, mAnt, ultimoDia(yAnt, mAnt)) },
  };
}

/** Parte un rango en ventanas de `dias` días (inclusive en ambos extremos). */
export function trocear(r: Rango, dias = DIAS_POR_VENTANA): Rango[] {
  const out: Rango[] = [];
  const fin = Date.parse(`${r.hasta}T00:00:00Z`);
  let cur = Date.parse(`${r.desde}T00:00:00Z`);
  while (cur <= fin) {
    const hasta = Math.min(cur + (dias - 1) * 86_400_000, fin);
    out.push({ desde: new Date(cur).toISOString().slice(0, 10), hasta: new Date(hasta).toISOString().slice(0, 10) });
    cur = hasta + 86_400_000;
  }
  return out;
}

/**
 * Parámetros en ORDEN EXACTO. hgiGet los recorre con Object.entries, que
 * preserva el orden de inserción de las claves string — no reordenar.
 */
const params = (r: Rango) => ({
  codigo_empresa: '*',
  codigo_transaccion: '*',
  documento: '*',
  codigo_tercero: '*',
  codigo_vendedor: '*',
  codigo_local: '*',
  fecha_inicial: r.desde,
  fecha_final: r.hasta,
  codigo_producto: '*',
  tipo_documento: '1',
});

/** Una ventana, con reintento y backoff exponencial ante fallos transitorios. */
async function fetchVentana(r: Rango): Promise<VentaLinea[]> {
  let ultimo: Error | null = null;
  for (let intento = 0; intento < REINTENTOS; intento++) {
    if (intento > 0) await sleep(BACKOFF_BASE_MS * 2 ** (intento - 1));
    try {
      const raw = await hgiGet<HgiVentaLinea[]>('Documentos', 'ObtenerDetalleReporte', params(r), {
        timeoutMs: VENTAS_TIMEOUT_MS,
      });
      return mapVentas(raw);
    } catch (err) {
      ultimo = err as Error;
      // Timeouts y cortes de red son transitorios: se reintenta.
      // Un HgiError con código propio es un error lógico: no insistir.
      if (err instanceof HgiError) throw err;
    }
  }
  throw new Error(`Ventas ${r.desde}..${r.hasta} falló tras ${REINTENTOS} intentos: ${ultimo?.message}`);
}

/** Ejecuta las ventanas con concurrencia limitada y una pausa entre llamadas. */
async function fetchRango(r: Rango): Promise<VentaLinea[]> {
  const trozos = trocear(r);
  const out: VentaLinea[] = [];
  let i = 0;
  async function worker() {
    while (i < trozos.length) {
      const v = trozos[i++];
      out.push(...(await fetchVentana(v)));
      await sleep(PAUSA_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCIA, trozos.length) }, worker));
  return out;
}

/**
 * data[] = líneas del MES CORRIENTE (crudas ya proyectadas, sin FotoProducto:
 * ese campo trae la imagen del producto y multiplicaría el tamaño del snapshot).
 * El mes anterior NO se guarda línea a línea — sólo entra agregado en el resumen,
 * que es para lo único que se usa (el comparativo de los KPIs).
 */
export async function buildVentasSnapshot(): Promise<BuildResult<VentaLinea>> {
  await getValidToken(); // prime del token cacheado

  const { actual, anterior } = ventanas();
  const t0 = Date.now();
  const lineasActual = await fetchRango(actual);
  const lineasAnterior = await fetchRango(anterior);

  const resumen = aggregateVentas(lineasActual, lineasAnterior, actual);

  return {
    data: lineasActual,
    sourceCounts: {
      ...resumen,
      fuente: 'Api/Documentos/ObtenerDetalleReporte (tipo_documento=1)',
      rangoActual: actual,
      rangoAnterior: anterior,
      ventanas: trocear(actual).length + trocear(anterior).length,
      lineasMesAnterior: lineasAnterior.length,
      buildMs: Date.now() - t0,
    },
  };
}

export type { VentasResumen, VentaLinea };
export { HgiError };
