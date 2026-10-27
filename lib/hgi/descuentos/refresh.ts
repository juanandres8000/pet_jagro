import { hoyColombia } from '../ventas';
import { ingestarVentana, type ResultadoIngestaDd } from './ingest';
import { readControlDd, type FilaControlDd, type Ventana } from './store';

/**
 * Orquestación del cron `descuentos` (una o varias ventanas mensuales por
 * corrida, con el cursor en dd_ventana_control). Mismo espíritu que pygRefresh:
 * sobrevive a que Vercel mate el lambda a mitad.
 *
 * Qué ventana toca, en orden:
 *  1. Meses "vivos" (el en curso y el anterior hasta el día 15): HGINet admite
 *     anulaciones y notas sobre facturas recientes, así que se re-leen si su
 *     última ingesta OK tiene más de HORAS_REFRESCO horas.
 *  2. Ventanas en error con intentos < MAX_INTENTOS.
 *  3. Meses cerrados nunca ingestados, del MÁS RECIENTE al más viejo (el módulo
 *     sirve desde la primera corrida).
 * Un mes cerrado con ingesta OK no se vuelve a pedir (salvo ?mes=YYYY-MM).
 */

/** Primer mes del histórico del módulo. */
export const MES_INICIAL = '2026-01';
const HORAS_REFRESCO = 6;
const MAX_INTENTOS = 3;
/** Día del mes hasta el cual el mes anterior sigue "vivo". */
const DIA_CORTE_MES_ANTERIOR = 15;
const FRACCION_PRESUPUESTO = 0.8;
/** Estimación conservadora de una ventana mensual (ventas ~6 trozos + 5 compras). */
const ESTIMADO_VENTANA_MS = 90_000;

const pad = (n: number) => String(n).padStart(2, '0');

export function ventanaDeMes(mes: string): Ventana {
  const [y, m] = mes.split('-').map(Number);
  const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { desde: `${mes}-01`, hasta: `${mes}-${pad(ultimo)}` };
}

/** Meses desde MES_INICIAL hasta el de `hoy`, ambos incluidos. */
export function mesesHasta(hoy: string, desde = MES_INICIAL): string[] {
  const out: string[] = [];
  let [y, m] = desde.split('-').map(Number);
  const [yf, mf] = hoy.slice(0, 7).split('-').map(Number);
  while (y < yf || (y === yf && m <= mf)) {
    out.push(`${y}-${pad(m)}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export function mesAnterior(mes: string): string {
  const [y, m] = mes.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

/** Elige las ventanas pendientes, en orden de prioridad (sin repetir). */
export function elegirVentanas(control: FilaControlDd[], hoy: string, ahoraMs: number): Array<{ mes: string; motivo: string }> {
  const porMes = new Map(control.map((c) => [c.desde.slice(0, 7), c]));
  const actual = hoy.slice(0, 7);
  const vivos = [actual];
  if (Number(hoy.slice(8, 10)) <= DIA_CORTE_MES_ANTERIOR) vivos.push(mesAnterior(actual));
  const out: Array<{ mes: string; motivo: string }> = [];
  const ya = new Set<string>();
  const add = (mes: string, motivo: string) => {
    if (!ya.has(mes) && mes >= MES_INICIAL) {
      ya.add(mes);
      out.push({ mes, motivo });
    }
  };

  for (const mes of vivos) {
    const c = porMes.get(mes);
    const viejo = !c?.okEn || ahoraMs - c.okEn.getTime() > HORAS_REFRESCO * 3_600_000;
    const agotado = c?.estado === 'error' && c.intentos >= MAX_INTENTOS && ahoraMs - c.actualizadoEn.getTime() < 3_600_000;
    if (viejo && !agotado) add(mes, c?.okEn ? 'mes vivo, refresco' : 'mes vivo sin ingestar');
  }
  for (const c of [...control].reverse()) {
    if (c.estado === 'error' && c.intentos < MAX_INTENTOS) add(c.desde.slice(0, 7), `reintento ${c.intentos + 1}/${MAX_INTENTOS}`);
  }
  for (const mes of mesesHasta(hoy).reverse()) {
    const c = porMes.get(mes);
    if (!c?.okEn && !(c && c.estado === 'error' && c.intentos >= MAX_INTENTOS)) add(mes, 'mes sin ingestar');
  }
  return out;
}

export interface ResultadoRefreshDd {
  dataset: 'descuentos';
  ventanas: Array<ResultadoIngestaDd & { motivo: string }>;
  errores: Array<{ mes: string; error: string }>;
  pendientes: number;
  sinTrabajo: boolean;
}

/**
 * Corre ventanas hasta agotar el presupuesto. `mes` fuerza una concreta.
 * Un error en una ventana no corta la corrida: queda registrado y se sigue.
 */
export async function refreshDescuentos(maxDurationS: number, mes?: string): Promise<ResultadoRefreshDd> {
  const t0 = Date.now();
  const presupuesto = maxDurationS * 1000 * FRACCION_PRESUPUESTO;
  const hoy = hoyColombia();
  let cola: Array<{ mes: string; motivo: string }>;
  if (mes) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes) || mes > hoy.slice(0, 7)) throw new Error(`mes inválido: ${mes}`);
    cola = [{ mes, motivo: 'forzado (?mes=)' }];
  } else {
    cola = elegirVentanas(await readControlDd(), hoy, Date.now());
  }

  const ventanas: ResultadoRefreshDd['ventanas'] = [];
  const errores: ResultadoRefreshDd['errores'] = [];
  let i = 0;
  for (; i < cola.length; i++) {
    if (Date.now() - t0 + ESTIMADO_VENTANA_MS > presupuesto) break;
    const { mes: m, motivo } = cola[i];
    console.log(`[descuentos] ventana ${m} — ${motivo}`);
    try {
      const r = await ingestarVentana(ventanaDeMes(m));
      console.log(
        `[descuentos] ${m} ok: ${r.lineasVenta} líneas de venta, ${r.docsPrecioCero} facturas con precio cero, ` +
          `${r.lineasCompra} de compra, ${(r.duracionMs / 1000).toFixed(1)}s`,
      );
      ventanas.push({ ...r, motivo });
    } catch (err) {
      console.error(`[descuentos] ${m} error:`, (err as Error).message);
      errores.push({ mes: m, error: (err as Error).message });
    }
  }
  return { dataset: 'descuentos', ventanas, errores, pendientes: cola.length - i, sinTrabajo: cola.length === 0 };
}
