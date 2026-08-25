import { hoyColombia } from './ventas';
import { pygIngest, type Ventana, type ResultadoIngesta } from './pygIngest';
import { refreshPlanCuentas } from './pygCuentaStore';
import {
  desplazarDia,
  finDeMes,
  mesesCerrados,
  readControl,
  readControlDias,
  readMesesSinCostoValorizado,
  ventanaDeMes,
  type FilaControl,
} from './pygStore';

/**
 * Orquestación de los crons del P&G. Sigue el patrón de ventasMensual: UNA
 * unidad de trabajo por corrida y el cursor en tabla (pyg_ventana_control), no
 * en memoria. Así el backfill sobrevive a que Vercel mate el lambda a mitad.
 *
 * REGLAS COMUNES A TODOS LOS DATASETS
 *  - Concurrencia 1: cada respuesta de DocumentosContables/Obtener son ~40-107 MB
 *    y dos en vuelo duplican el pico de memoria (medido: 550 MB por ventana
 *    mensual). No se paraleliza aunque HGINet lo aguantaría.
 *  - Pausa de 400 ms entre ventanas, igual que fetchRango en ventas.ts.
 *  - La respuesta se libera dentro de pygIngest antes de escribir; aquí además
 *    no se acumulan resultados crudos entre ventanas.
 *  - Log por ventana con duración: el mensaje viaja al body y Vercel no loguea
 *    response bodies, así que sin console.log la corrida del cron es opaca.
 */

/** Presupuesto: fracción del maxDuration que se puede gastar antes de responder. */
const FRACCION_PRESUPUESTO = 0.8;
/** Pausa entre ventanas, igual que ventas.ts. */
const PAUSA_MS = 400;
/** Reintentos por ventana antes de dejarla en error definitivo. */
const MAX_INTENTOS = 3;
/** Días hacia atrás que revisa el refresco diario (hoy incluido). */
export const DIAS_RECIENTES = 7;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ResultadoRefresh {
  dataset: string;
  ventanas: Array<{
    desde: string;
    hasta: string;
    lineas: number;
    documentos: number;
    cuadra: boolean;
    duracionMs: number;
    motivo: string;
  }>;
  sinTrabajo: boolean;
  restantes?: number;
}

/** Ejecuta una ventana, la loguea y devuelve su resumen. */
async function correrVentana(v: Ventana, motivo: string): Promise<ResultadoIngesta> {
  const t0 = Date.now();
  console.log(`[pyg] ventana [${v.desde} … ${v.hasta}] — ${motivo}`);
  const r = await pygIngest(v);
  console.log(
    `[pyg] ventana [${v.desde} … ${v.hasta}] ok: ${r.lineas} líneas, ${r.documentos} docs, ` +
      `cuadra=${r.cuadra}, ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  return r;
}

const claveVentana = (desde: string, hasta: string) => `${desde}|${hasta}`;

// ------------------------------------------------------- pyg_cuentas ------

/** Refresca el plan de cuentas PCGA. Una sola llamada, ~5s. */
export async function refreshPygCuentas() {
  const r = await refreshPlanCuentas();
  console.log(
    r.rechazadoPorGuard
      ? `[pyg] plan RECHAZADO por el guard de ratio (existentes: ${r.existentes})`
      : `[pyg] plan actualizado: ${r.filas} cuentas, ${r.hojas} hojas`,
  );
  return r;
}

// ------------------------------------------------------ pyg_backfill ------

/**
 * Elige la ventana MENSUAL que toca ingestar.
 *
 * Prioridad:
 *  1. Meses en error con intentos < MAX_INTENTOS (del más reciente al más viejo):
 *     un fallo transitorio de HGINet no debe empujar el mes al final de la cola.
 *  2. Meses cerrados sin fila ok, del MÁS RECIENTE al más viejo — igual que
 *     elegirMes de ventasMensual: así el módulo sirve desde la primera corrida
 *     en vez de esperar a que el backfill llegue al presente.
 */
export function elegirMesBackfill(
  control: FilaControl[],
  hoy: string,
): { mes: string; motivo: string } | null {
  const porClave = new Map(control.map((c) => [claveVentana(c.desde, c.hasta), c]));
  const cerrados = mesesCerrados(hoy);

  for (const mes of cerrados) {
    const c = porClave.get(claveVentana(`${mes}-01`, finDeMes(mes)));
    if (c && c.estado === 'error' && c.intentos < MAX_INTENTOS) {
      return { mes, motivo: `reintento ${c.intentos + 1}/${MAX_INTENTOS} tras error` };
    }
  }
  for (const mes of cerrados) {
    const c = porClave.get(claveVentana(`${mes}-01`, finDeMes(mes)));
    if (!c || (c.estado !== 'ok' && c.estado !== 'vacio' && c.intentos >= MAX_INTENTOS)) {
      if (c && c.intentos >= MAX_INTENTOS) continue; // agotado, no reintentar en bucle
      return { mes, motivo: 'mes cerrado sin ingestar' };
    }
  }
  return null;
}

/** Cuántos meses cerrados quedan pendientes (para reportar progreso). */
function pendientesBackfill(control: FilaControl[], hoy: string): number {
  const porClave = new Map(control.map((c) => [claveVentana(c.desde, c.hasta), c]));
  return mesesCerrados(hoy).filter((mes) => {
    const c = porClave.get(claveVentana(`${mes}-01`, finDeMes(mes)));
    return !c || (c.estado !== 'ok' && c.estado !== 'vacio' && c.intentos < MAX_INTENTOS);
  }).length;
}

/**
 * Backfill: UNA ventana mensual por invocación.
 *
 * Es deliberadamente una sola: una ventana mensual midió 120s (fetch + aplanado
 * + 17 INSERT por lotes) con un pico de 550 MB. Dos en la misma invocación se
 * acercarían demasiado al maxDuration de 300s.
 */
export async function refreshPygBackfill(mesForzado?: string): Promise<ResultadoRefresh> {
  const hoy = hoyColombia();
  const control = await readControl();

  const elegido = mesForzado
    ? { mes: mesForzado, motivo: 'mes forzado por parámetro' }
    : elegirMesBackfill(control, hoy);

  if (!elegido) {
    console.log('[pyg] backfill sin trabajo: todos los meses cerrados están ingestados');
    return { dataset: 'pyg_backfill', ventanas: [], sinTrabajo: true, restantes: 0 };
  }

  const v = ventanaDeMes(elegido.mes);
  const r = await correrVentana(v, elegido.motivo);
  const restantes = mesForzado ? undefined : pendientesBackfill(await readControl(), hoy);

  return {
    dataset: 'pyg_backfill',
    ventanas: [
      {
        desde: v.desde,
        hasta: v.hasta,
        lineas: r.lineas,
        documentos: r.documentos,
        cuadra: r.cuadra,
        duracionMs: r.duracionMs,
        motivo: elegido.motivo,
      },
    ],
    sinTrabajo: false,
    restantes,
  };
}

// ---------------------------------------------------------- pyg_dia -------

/**
 * Ordena los días de [hoy-6 … hoy] por urgencia: primero los que nunca se
 * ingestaron, luego los de `actualizado_en` más viejo. Ese es el cursor: no hay
 * estado en memoria entre corridas.
 */
export function ordenarDiasRecientes(control: FilaControl[], hoy: string): string[] {
  const porDia = new Map(control.filter((c) => c.desde === c.hasta).map((c) => [c.desde, c]));
  const dias: string[] = [];
  for (let i = DIAS_RECIENTES - 1; i >= 0; i--) dias.push(desplazarDia(hoy, -i));
  return dias.sort((a, b) => {
    const ca = porDia.get(a);
    const cb = porDia.get(b);
    if (!ca && !cb) return a < b ? 1 : -1; // sin ingestar: el más reciente primero
    if (!ca) return -1;
    if (!cb) return 1;
    return ca.actualizadoEn.getTime() - cb.actualizadoEn.getTime();
  });
}

/**
 * Refresco diario: ventanas de UN día sobre los últimos DIAS_RECIENTES, tantas
 * como quepan en el 80% del maxDuration.
 *
 * Por qué re-consultar días ya ingestados: la digitación tardía y las
 * anulaciones existen (en junio, 312 líneas venían con Estado<>0 en la cabecera),
 * y el DELETE de sustitución de pygIngest sólo puede limpiarlas si la ventana se
 * vuelve a correr.
 */
export async function refreshPygDia(maxDurationSec: number): Promise<ResultadoRefresh> {
  const t0 = Date.now();
  const presupuestoMs = maxDurationSec * 1000 * FRACCION_PRESUPUESTO;
  const hoy = hoyColombia();
  const control = await readControlDias(desplazarDia(hoy, -(DIAS_RECIENTES - 1)), hoy);
  const dias = ordenarDiasRecientes(control, hoy);

  const ventanas: ResultadoRefresh['ventanas'] = [];
  // Estimación inicial generosa: un día suelto midió 29-49s de fetch más la
  // escritura. Tras la primera ventana se usa la duración real observada.
  let estimadoMs = 60_000;

  for (const dia of dias) {
    const transcurrido = Date.now() - t0;
    if (transcurrido + estimadoMs > presupuestoMs) {
      console.log(
        `[pyg] pyg_dia corta en ${ventanas.length} ventanas: ` +
          `${Math.round(transcurrido / 1000)}s gastados de ${Math.round(presupuestoMs / 1000)}s de presupuesto`,
      );
      break;
    }
    const r = await correrVentana({ desde: dia, hasta: dia }, 'refresco de día reciente');
    ventanas.push({
      desde: dia,
      hasta: dia,
      lineas: r.lineas,
      documentos: r.documentos,
      cuadra: r.cuadra,
      duracionMs: r.duracionMs,
      motivo: 'refresco de día reciente',
    });
    estimadoMs = Math.max(r.duracionMs, 10_000);
    await sleep(PAUSA_MS);
  }

  return { dataset: 'pyg_dia', ventanas, sinTrabajo: ventanas.length === 0 };
}

// ------------------------------------------------------ pyg_cierres -------

/**
 * Re-consulta el ÚLTIMO DÍA de los meses cuyo costo de ventas sigue sin
 * valorizar, porque el asiento se valoriza tarde.
 *
 * No es una precaución teórica: medido en 2026, el asiento `COSTO DE VENTA <MES>`
 * (comprobante 27, docs correlativos 76-79) existe desde el día del cierre pero
 * sólo abril trae valor; mayo, junio y julio están en cero. Cuando el contador
 * los valorice, esta corrida lo detecta y el fallback se apaga solo.
 */
export async function refreshPygCierres(maxDurationSec: number): Promise<ResultadoRefresh> {
  const t0 = Date.now();
  const presupuestoMs = maxDurationSec * 1000 * FRACCION_PRESUPUESTO;
  const meses = await readMesesSinCostoValorizado(12);

  if (meses.length === 0) {
    console.log('[pyg] pyg_cierres sin trabajo: no hay meses con costo en cero');
    return { dataset: 'pyg_cierres', ventanas: [], sinTrabajo: true };
  }

  const ventanas: ResultadoRefresh['ventanas'] = [];
  let estimadoMs = 60_000;

  for (const mes of meses) {
    const transcurrido = Date.now() - t0;
    if (transcurrido + estimadoMs > presupuestoMs) {
      console.log(`[pyg] pyg_cierres corta en ${ventanas.length} de ${meses.length} ventanas por presupuesto`);
      break;
    }
    const dia = finDeMes(mes);
    const r = await correrVentana({ desde: dia, hasta: dia }, `cierre de ${mes} con costo sin valorizar`);
    ventanas.push({
      desde: dia,
      hasta: dia,
      lineas: r.lineas,
      documentos: r.documentos,
      cuadra: r.cuadra,
      duracionMs: r.duracionMs,
      motivo: `cierre de ${mes} con costo sin valorizar`,
    });
    estimadoMs = Math.max(r.duracionMs, 10_000);
    await sleep(PAUSA_MS);
  }

  return { dataset: 'pyg_cierres', ventanas, sinTrabajo: false, restantes: meses.length - ventanas.length };
}
