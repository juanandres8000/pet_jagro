import { hgiGet, getValidToken } from './client';
import { mapResumenClases, aggregateClases, type HgiResumenClase, type ClaseSaldo } from './mappers/clases';
import type { BuildResult } from './readThrough';

/**
 * Construcción del dataset de composición de cartera por clase.
 * Método real verificado: Api/Cartera/ResumenPorClases.
 *
 * UNA SOLA LLAMADA con periodo='*'. Medido en vivo: el año completo tarda 32s y
 * trae 1.271 filas, contra 21s por un solo mes. No hay nada que trocear, y
 * trocear sería además INCORRECTO: `Saldo` es un saldo, no un flujo, así que
 * iterar periodos y sumar multiplicaría la cartera. Ver la nota larga en
 * mappers/clases.ts.
 *
 * `tipo_cartera` se fija en 0 (General): es el único con datos en esta instancia
 * (1 Cuotas y 3 Tipo devuelven 0 filas), y por eso la vista no expone selector.
 */

// El año completo son ~32s medidos; margen amplio sobre eso.
const CLASES_TIMEOUT_MS = 120_000;

/** ORDEN EXACTO de la firma: el routing de WebAPI es por firma, no por nombre. */
const params = (anyo: number) => ({
  anyo: String(anyo),
  periodo: '*',
  codigo_tercero: '*',
  codigo_local: '*',
  tipo_cartera: '0',
  grupo: '*',
});

/** Año en curso en hora de Colombia (UTC-5 permanente). */
function anyoColombia(): number {
  return new Date(Date.now() - 5 * 60 * 60 * 1000).getUTCFullYear();
}

export async function buildClasesSnapshot(): Promise<BuildResult<ClaseSaldo>> {
  await getValidToken(); // prime del token cacheado

  const anyoActual = anyoColombia();
  const t0 = Date.now();

  let anyoUsado = anyoActual;
  let filas = mapResumenClases(
    await hgiGet<HgiResumenClase[]>('Cartera', 'ResumenPorClases', params(anyoActual), {
      timeoutMs: CLASES_TIMEOUT_MS,
    }),
  );

  // Mismo fallback que Cartera/Obtener: a comienzos de año el ejercicio en curso
  // puede venir vacío y el saldo vivo está en el anterior.
  if (filas.length === 0) {
    anyoUsado = anyoActual - 1;
    filas = mapResumenClases(
      await hgiGet<HgiResumenClase[]>('Cartera', 'ResumenPorClases', params(anyoUsado), {
        timeoutMs: CLASES_TIMEOUT_MS,
      }),
    );
  }

  const resumen = aggregateClases(filas, anyoUsado);

  return {
    data: filas,
    sourceCounts: {
      ...resumen,
      fuente: 'Api/Cartera/ResumenPorClases (periodo=*, tipo_cartera=0)',
      anyoConsultado: anyoUsado,
      buildMs: Date.now() - t0,
    },
  };
}
