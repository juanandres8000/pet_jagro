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
 * filas. En serie no cabe en el maxDuration de la ruta (300s).
 *
 * Su latencia depende del VOLUMEN de filas, no del ancho del rango, así que la
 * ventana es de UN DÍA: trocear más fino reparte mejor la carga entre workers y
 * evita que una ventana gorda marque el wall-clock. Medido sobre el mismo mes
 * (5.334 filas): 8 ventanas de 3 días → 90s; 24 ventanas de 1 día con
 * concurrencia 12 → 44s. El día más pesado del mes (641 filas) tardó 42s, y ese
 * es el piso: nada baja de la ventana más lenta.
 */

const RECAUDO_TIMEOUT_MS = 120_000;
const DIAS_POR_VENTANA = 1;
// HGINet NO limita por ritmo de llamadas: los 400 que parecían rate-limiting
// resultaron ser token caducado (400 con cuerpo vacío). Verificado con 12
// ventanas simultáneas, todas 200.
const CONCURRENCIA = 12;
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
