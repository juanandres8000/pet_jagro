import { hgiGet, getValidToken } from './client';
import { detectarPeriodoVigente } from './periodoVigente';
import { mapResumenClases, aggregateClases, type HgiResumenClase, type ClaseSaldo } from './mappers/clases';
import type { BuildResult } from './readThrough';

/**
 * Construcción del dataset de composición de cartera por clase.
 * Método real verificado: Api/Cartera/ResumenPorClases.
 *
 * UNA SOLA LLAMADA, con el PERIODO VIGENTE — nunca periodo='*'.
 *
 * CORRECCIÓN sobre lo que decía antes esta nota: se creía que periodo='*' hacía
 * que el ERP consolidara. NO lo hace. Devuelve una fila por (clase, tercero,
 * banco) Y POR PERIODO, y `aggregateClases` las sumaba: 15.404.367.512 no era el
 * saldo, era la suma de los saldos de cierre de todos los meses. Con el periodo
 * vigente da 2.538.016.294. Es la misma patología que tenía Cartera/Obtener y
 * está medida en lib/hgi/periodoVigente.ts.
 *
 * Que `Saldo` sea un SALDO y no un flujo sigue siendo cierto — y es justo por eso
 * que no se puede sumar entre periodos.
 *
 * `tipo_cartera` se fija en 0 (General): es el único con datos en esta instancia
 * (1 Cuotas y 3 Tipo devuelven 0 filas), y por eso la vista no expone selector.
 *
 * POR QUÉ LA VISTA "COMPOSICIÓN" NO TIENE ENTRADA DE NAV
 * Medido en vivo sobre 2026: el ERP devuelve UNA SOLA clase para toda la cartera
 * —código 0, "GENERAL"—. (Las cifras que citaba esta nota, 1.271 registros y
 * $13.675.461.337, salían de periodo='*' y estaban infladas ~6x; lo que no cambia
 * es que hay una sola clase.) Un desglose de una sola categoría no es un desglose, así que la entrada
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
const params = (anyo: number, periodo: number) => ({
  anyo: String(anyo),
  periodo: String(periodo),
  codigo_tercero: '*',
  codigo_local: '*',
  tipo_cartera: '0',
  grupo: '*',
});

export async function buildClasesSnapshot(): Promise<BuildResult<ClaseSaldo>> {
  await getValidToken(); // prime del token cacheado

  const t0 = Date.now();

  // El MISMO periodo vigente que usa Cartera/Obtener, para que las dos fuentes
  // sean comparables. Medido: a nivel de periodo reconcilian dentro del 2%
  // (la diferencia es netear por tercero contra sumar por documento).
  const { pv } = await detectarPeriodoVigente();

  const filas = mapResumenClases(
    await hgiGet<HgiResumenClase[]>('Cartera', 'ResumenPorClases', params(pv.anyo, pv.periodo), {
      timeoutMs: CLASES_TIMEOUT_MS,
    }),
  );

  const resumen = aggregateClases(filas, pv.anyo);

  return {
    data: filas,
    sourceCounts: {
      ...resumen,
      fuente: `Api/Cartera/ResumenPorClases (periodo=${pv.periodo}, tipo_cartera=0)`,
      anyoConsultado: pv.anyo,
      periodoVigente: pv.periodo,
      periodoDeteccion: { anyo: pv.anyo, periodo: pv.periodo, descartados: pv.descartados },
      buildMs: Date.now() - t0,
    },
  };
}
