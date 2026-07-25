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
 *
 * POR QUÉ LA VISTA "COMPOSICIÓN" NO TIENE ENTRADA DE NAV
 * Medido en vivo sobre 2026: el ERP devuelve UNA SOLA clase para toda la cartera
 * —código 0, "GENERAL"— con 1.271 registros, 1.270 terceros y $13.675.461.337
 * netos. Un desglose de una sola categoría no es un desglose, así que la entrada
 * de menú prometía algo que el dato no tiene. Ídem el banco: `NombreBanco` llega
 * poblado pero con un único valor ("GENERAL"), de ahí `bancoDiscrimina`.
 *
 * Lo que el dato SÍ discrimina es el SIGNO: 135 terceros con saldo a favor por
 * −$1.728.906.175, el 11% del saldo por cobrar. Eso no era visible en ningún
 * módulo porque Cartera/Obtener filtra SaldoFinal > 0. Por eso ese hallazgo se
 * movió al KPI "Saldos a favor" de la vista de Cartera, y esta vista quedó
 * montada pero sin nav, lista para el día en que el ERP empiece a clasificar.
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
