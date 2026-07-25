import { hgiGet } from './client';
import type { HgiCarteraDoc } from './mappers/cartera';

/**
 * Detección del PERIODO VIGENTE de cartera.
 *
 * ================== POR QUÉ ESTO EXISTE ==================
 *
 * `Api/Cartera/Obtener` y `Api/Cartera/ResumenPorClases` con `periodo='*'`
 * devuelven un LIBRO POR PERIODO: una fila por documento **y por mes**, con el
 * saldo de CIERRE de ese mes. Sumarlas multiplica la deuda por el número de
 * meses que el documento estuvo abierto.
 *
 * Evidencia medida (factura 196509, tercero 900323135, 2026):
 *   Periodo 6 · SaldoInicial 0         · ValorGenerado 1.793.018 · SaldoFinal 1.793.018
 *   Periodo 7 · SaldoInicial 1.793.018 · ValorGenerado 0         · SaldoFinal 1.793.018
 *   Periodo 8 · SaldoInicial 1.793.018 · ValorGenerado 0         · SaldoFinal 1.793.018
 * Es la MISMA deuda arrastrada tres meses, no tres deudas. Los tres registros son
 * idénticos salvo `Periodo`, `SaldoInicial` y `ValorGeneradoPeriodo`.
 *
 * Con periodo='*' el titular de cartera daba 15.766.172.168 contra los
 * 2.577.420.853 reales del periodo 7: **~6x**. Y no es exclusivo de un endpoint —
 * ResumenPorClases con periodo='*' daba 15.404.367.512, la suma de sus periodos.
 *
 * Cada periodo YA incluye los documentos viejos: el `minFecha` de los 8 periodos
 * de 2026 es 2020-01-01. No hay nada que "traer" de años anteriores, y sumar años
 * es igual de incorrecto (los cuatro años daban 28.528.773.031, 1,85x de más,
 * porque el abierto al cierre de 2023 incluye deuda pagada en 2024).
 *
 * REGLA: el saldo vigente es el SaldoFinal del ÚLTIMO PERIODO CON CIERRE REAL.
 * Nunca la suma de periodos, nunca la suma de años. Si alguien vuelve a poner
 * periodo='*' buscando "la serie mensual", multiplica la cartera por ~6.
 *
 * =========================================================
 *
 * Cómo se detecta: `ValorGeneradoPeriodo != 0` marca que en ese mes hubo
 * documentos generados, o sea que el periodo tiene movimiento real. Un periodo de
 * puro arrastre (el ERP pre-genera la apertura del mes siguiente) trae 0 filas
 * con ValorGenerado, 0 con ValorPagado y ninguna con SaldoInicial en 0 — medido
 * en el periodo 8 de 2026, que es la apertura de agosto con corte al 09-07.
 *
 * Se prueba de forma DESCENDENTE desde el mes en curso, así que el primer
 * periodo con actividad es el vigente y sus filas ya vienen en la misma llamada:
 * en el caso normal es UNA sola consulta.
 */

const CARTERA_TIMEOUT_MS = 60_000;

/**
 * El periodo 13 es el CIERRE ANUAL, no un mes: en 2025 viene idéntico al 12
 * (2.791 filas, 1.461.967.141, misma fecha máxima). Nunca se prueba porque la
 * búsqueda arranca en el mes en curso (máximo 12), pero se deja explícito.
 */
export const PERIODO_CIERRE_ANUAL = 13;

export interface PeriodoVigente {
  anyo: number;
  periodo: number;
  /** Periodos probados y descartados, en orden. Para auditar la detección. */
  descartados: Array<{ anyo: number; periodo: number; filas: number; motivo: string }>;
}

export interface CarteraDelPeriodo {
  pv: PeriodoVigente;
  /** Filas del periodo vigente, ya traídas por la detección. */
  filas: HgiCarteraDoc[];
}

const num = (v: unknown): number => {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

const params = (anyo: number, periodo: number) => ({
  anyo: String(anyo),
  periodo: String(periodo),
  codigo_tercero: '*',
  codigo_local: '*',
  tipo_cartera: '*',
  grupo: '*',
  codigo_clase: '*',
});

/** Un periodo tiene cierre real si alguna fila trae ValorGeneradoPeriodo != 0. */
export const tieneActividad = (filas: HgiCarteraDoc[]): boolean =>
  filas.some((f) => num(f.ValorGeneradoPeriodo) !== 0);

/** Mes en curso en hora de Colombia (UTC-5 permanente), 1..12. */
function mesColombia(hoy?: Date): number {
  const d = hoy ?? new Date(Date.now() - 5 * 60 * 60 * 1000);
  return d.getUTCMonth() + 1;
}

/** Año en curso en hora de Colombia. */
function anyoColombia(hoy?: Date): number {
  const d = hoy ?? new Date(Date.now() - 5 * 60 * 60 * 1000);
  return d.getUTCFullYear();
}

/**
 * Busca el último periodo con actividad de un año, bajando desde `desde`.
 * Devuelve null si ninguno del rango la tiene.
 */
async function buscarEnAnyo(
  anyo: number,
  desde: number,
  descartados: PeriodoVigente['descartados'],
): Promise<CarteraDelPeriodo | null> {
  for (let p = desde; p >= 1; p--) {
    const raw = await hgiGet<HgiCarteraDoc[]>('Cartera', 'Obtener', params(anyo, p), {
      timeoutMs: CARTERA_TIMEOUT_MS,
    });
    const filas = Array.isArray(raw) ? raw : [];
    if (filas.length > 0 && tieneActividad(filas)) {
      return { pv: { anyo, periodo: p, descartados }, filas };
    }
    descartados.push({
      anyo,
      periodo: p,
      filas: filas.length,
      motivo: filas.length === 0 ? 'sin filas' : 'sin ValorGeneradoPeriodo != 0 (arrastre puro)',
    });
  }
  return null;
}

/**
 * Devuelve el periodo vigente y sus filas.
 *
 * Casos borde cubiertos:
 *  - Inicio de mes sin actividad todavía → cae al periodo anterior.
 *  - Periodo de puro arrastre (apertura pre-generada) → se descarta y baja.
 *  - Enero de un año nuevo sin ningún periodo con actividad → cae al año
 *    ANTERIOR empezando por el 12. Nunca devuelve 0.
 *  - El periodo 13 (cierre anual) queda fuera por construcción: la búsqueda
 *    arranca en el mes en curso, que es 12 como máximo.
 */
export async function detectarPeriodoVigente(hoy?: Date): Promise<CarteraDelPeriodo> {
  const anyo = anyoColombia(hoy);
  const mes = mesColombia(hoy);
  const descartados: PeriodoVigente['descartados'] = [];

  const enActual = await buscarEnAnyo(anyo, mes, descartados);
  if (enActual) return enActual;

  // Año nuevo sin actividad aún: el saldo vigente es el último cierre del año
  // anterior. Se empieza por el 12 (el 13 es cierre anual, no un mes).
  const enAnterior = await buscarEnAnyo(anyo - 1, 12, descartados);
  if (enAnterior) return enAnterior;

  throw new Error(
    `No se encontró ningún periodo con cierre real en ${anyo} ni en ${anyo - 1}. ` +
      `Probados: ${descartados.map((d) => `${d.anyo}-${d.periodo}(${d.motivo})`).join(', ')}`,
  );
}
