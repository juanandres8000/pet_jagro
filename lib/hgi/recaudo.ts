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
 * Igual que Ventas: el rango completo del mes se pasa del timeout (23 días
 * >180s), así que se pagina. Ventanas de 5 días, concurrencia 2 y backoff ante
 * los 400 transitorios que HGINet devuelve cuando se le llama a mucho ritmo.
 * Sólo mes corriente: el comparativo mensual vive en Ventas.
 */

/**
 * ObtenerRecaudo es MÁS lento que ObtenerDetalleReporte y su latencia no es
 * lineal con el rango: medido 1 día → 1,8s, 2 días → 2,2s, pero 3 días → 25,7s
 * y 5 días → 40,9s. Con dos ventanas en vuelo y HGINet bajo carga, 60s se
 * quedaban cortos y el build entero fallaba por timeout de una sola ventana.
 * 120s da margen suficiente sin acercarse al maxDuration de la ruta (300s).
 */
const RECAUDO_TIMEOUT_MS = 120_000;
const CONCURRENCIA = 2;
const REINTENTOS = 3;
const BACKOFF_BASE_MS = 1500;
const PAUSA_MS = 400;

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
  const trozos = trocear(r);
  const out: RecaudoLinea[] = [];
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
      ventanas: trocear(actual).length,
      lineasCrudas: lineas.length,
      buildMs: Date.now() - t0,
    },
  };
}

export type { RecaudoResumen, RecaudoLinea };
export { HgiError };
