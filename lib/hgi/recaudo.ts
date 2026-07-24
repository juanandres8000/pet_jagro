import { hgiGet, HgiError, getValidToken } from './client';
import {
  mapRecaudo,
  aggregateRecaudo,
  type HgiRecaudoDoc,
  type RecaudoLinea,
  type RecaudoResumen,
} from './mappers/recaudo';
import { ventanas, trocear, type Rango } from './ventas';
import type { BuildResult } from './readThrough';

/**
 * Construcción del dataset de Recaudo contra HGINet.
 * Método real verificado: Api/Cartera/ObtenerRecaudo con
 * codigo_tercero=*&fecha_inicial=&fecha_final=.
 *
 * Sólo mes corriente: el comparativo mensual vive en Ventas.
 *
 * Es el endpoint más lento del sistema: ~17 filas/segundo, y el mes son ~5.300
 * filas. En serie no cabe en el maxDuration de la ruta (300s), así que se
 * pagina en ventanas de 3 días y se lanzan TODAS en paralelo: medido, el mes
 * completo baja a ~90s de wall-clock con las 8 ventanas en vuelo a la vez.
 *
 * Su latencia depende del VOLUMEN de filas, no del ancho del rango: 3 días con
 * 129 filas tardan 11s y 3 días con 1.336 filas tardan 90s. Por eso el timeout
 * por ventana es holgado (200s) aunque la ventana sea corta.
 */

const RECAUDO_TIMEOUT_MS = 200_000;
const DIAS_POR_VENTANA = 3;
// HGINet NO limita por ritmo de llamadas: los 400 que parecían rate-limiting
// resultaron ser token caducado (400 con cuerpo vacío). Verificado con 8
// ventanas simultáneas, todas 200.
const CONCURRENCIA = 8;
const REINTENTOS = 3;
const BACKOFF_BASE_MS = 1500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Orden de parámetros según la firma verificada. */
const params = (r: Rango) => ({
  codigo_tercero: '*',
  fecha_inicial: r.desde,
  fecha_final: r.hasta,
});

async function fetchVentana(r: Rango): Promise<RecaudoLinea[]> {
  let ultimo: Error | null = null;
  for (let intento = 0; intento < REINTENTOS; intento++) {
    if (intento > 0) await sleep(BACKOFF_BASE_MS * 2 ** (intento - 1));
    try {
      const raw = await hgiGet<HgiRecaudoDoc[]>('Cartera', 'ObtenerRecaudo', params(r), {
        timeoutMs: RECAUDO_TIMEOUT_MS,
      });
      return mapRecaudo(raw);
    } catch (err) {
      ultimo = err as Error;
      if (err instanceof HgiError) throw err; // error lógico: no insistir
    }
  }
  throw new Error(`Recaudo ${r.desde}..${r.hasta} falló tras ${REINTENTOS} intentos: ${ultimo?.message}`);
}

async function fetchRango(r: Rango): Promise<RecaudoLinea[]> {
  const trozos = trocear(r, DIAS_POR_VENTANA);
  const out: RecaudoLinea[] = [];
  let i = 0;
  async function worker() {
    while (i < trozos.length) {
      out.push(...(await fetchVentana(trozos[i++])));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCIA, trozos.length) }, worker));
  return out;
}

export async function buildRecaudoSnapshot(): Promise<BuildResult<RecaudoLinea>> {
  await getValidToken(); // prime del token cacheado

  const { actual } = ventanas();
  const t0 = Date.now();
  const lineas = await fetchRango(actual);
  const resumen = aggregateRecaudo(lineas, actual);

  return {
    data: lineas,
    sourceCounts: {
      ...resumen,
      fuente: 'Api/Cartera/ObtenerRecaudo',
      rango: actual,
      ventanas: trocear(actual, DIAS_POR_VENTANA).length,
      lineasCrudas: lineas.length,
      buildMs: Date.now() - t0,
    },
  };
}

export type { RecaudoResumen, RecaudoLinea };
export { HgiError };
