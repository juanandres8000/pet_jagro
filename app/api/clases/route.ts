import { NextResponse } from 'next/server';
import { HgiError } from '@/lib/hgi/client';
import { buildClasesSnapshot } from '@/lib/hgi/clases';
import { readThrough, ttlMsFromEnv } from '@/lib/hgi/readThrough';
import { aggregateClases, type ClaseSaldo, type ClasesResumen } from '@/lib/hgi/mappers/clases';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// El build es UNA llamada a ResumenPorClases: ~32s medidos para el año completo.
// 60 da margen para un lambda lento sin acercarse al techo.
// El mismo valor alimenta el presupuesto de tiempo de readThrough,
// así que no pueden desincronizarse.
const MAX_DURATION_SEC = 60;
export const maxDuration = MAX_DURATION_SEC;

/**
 * Composición de cartera por clase de documento, con caché read-through
 * (dataset 'clases'). Sirve del snapshot dentro del TTL; reconstruye al vencer;
 * serve-stale si el rebuild falla.
 *
 * Los agregados se calculan SIEMPRE en el lambda: la vista no baja las 1.271
 * filas para agrupar en el browser.
 *   GET /api/clases              → resumen por clase y por banco + totales
 *   GET /api/clases?clase=X      → drill: terceros de esa clase, paginado
 *
 * `Saldo` es un SALDO y nunca se suma entre periodos — ver la nota larga en
 * lib/hgi/mappers/clases.ts. Los negativos se conservan con signo en todos los
 * agregados de esta ruta.
 */

const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 100;

/** El resumen guardado en sourceCounts al construir el snapshot. */
type ResumenGuardado = ClasesResumen & { fuente?: string; anyoConsultado?: number; buildMs?: number };

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const clase = sp.get('clase');
  // `signo` permite pedir sólo los saldos a favor del tercero (negativos) sin
  // bajar las 1.271 filas al browser para filtrarlas ahí. Es lo que consume el
  // KPI "Saldos a favor" de Cartera.
  const signoParam = sp.get('signo');
  const signo = signoParam === 'negativo' || signoParam === 'positivo' ? signoParam : null;
  const ordenParam = sp.get('orden');
  const orden =
    ordenParam === 'nombre' ? 'nombre' : ordenParam === 'saldoAsc' ? 'saldoAsc' : 'saldo';
  const page = Math.max(1, Number(sp.get('page')) || 1);
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(5, Number(sp.get('pageSize')) || PAGE_SIZE_DEFAULT));

  try {
    const rt = await readThrough<ClaseSaldo>(
      'clases',
      ttlMsFromEnv('HGI_CLASES_TTL_MIN', 60),
      buildClasesSnapshot,
      { maxDurationSec: MAX_DURATION_SEC },
    );

    const filas = rt.snapshot.data;
    // El resumen viene precalculado del build; si el snapshot es viejo y no lo
    // trae, se recalcula sobre las filas (mismo agregador, mismas reglas).
    const guardado = rt.snapshot.sourceCounts as unknown as ResumenGuardado | null;
    const resumen: ClasesResumen =
      guardado && Array.isArray(guardado.porClase)
        ? guardado
        : aggregateClases(filas, guardado?.anyoConsultado ?? new Date().getUTCFullYear());

    const meta = {
      ok: true,
      anyo: resumen.anyo,
      cached: rt.cached,
      stale: rt.stale,
      built_at: rt.snapshot.builtAt.toISOString(),
      fuente: guardado?.fuente ?? null,
      ...(rt.rebuildError ? { rebuildError: rt.rebuildError } : {}),
    };

    // ---- Drill: filas por clase y/o por signo del saldo ----
    // Filtrar y paginar aquí, no en la vista: el dataset son 1.271 filas y el
    // browser no tiene por qué verlas para mostrar 25.
    if (clase !== null || signo !== null) {
      const sel = filas.filter(
        (f) =>
          (clase === null || f.codigoClase === clase) &&
          (signo === null || (signo === 'negativo' ? f.saldo < 0 : f.saldo >= 0)),
      );
      const ordenadas = [...sel].sort((a, b) => {
        if (orden === 'nombre') return a.nombreTercero.localeCompare(b.nombreTercero, 'es');
        // saldoAsc pone el saldo MÁS negativo primero, que es el orden útil
        // cuando se listan saldos a favor.
        return orden === 'saldoAsc' ? a.saldo - b.saldo : b.saldo - a.saldo;
      });
      const total = ordenadas.length;
      const maxPage = Math.max(1, Math.ceil(total / pageSize));
      const pageSafe = Math.min(page, maxPage);
      const grupo = clase !== null ? resumen.porClase.find((c) => c.codigo === clase) ?? null : null;
      const saldoSeleccion = sel.reduce((a, f) => a + f.saldo, 0);

      return NextResponse.json({
        ...meta,
        clase,
        signo,
        nombreClase: grupo?.nombre ?? sel[0]?.nombreClase ?? clase,
        grupo,
        saldoSeleccion,
        terceros: {
          page: pageSafe,
          pageSize,
          total,
          filas: ordenadas.slice((pageSafe - 1) * pageSize, pageSafe * pageSize),
        },
      });
    }

    // ---- Resumen ----
    return NextResponse.json({
      ...meta,
      porClase: resumen.porClase,
      // Se omite el corte por banco si el ERP no discrimina (un único valor
      // comodín): un gráfico de una sola barra al 100% no informa nada.
      porBanco: resumen.bancoDiscrimina ? resumen.porBanco : [],
      bancoDiscrimina: resumen.bancoDiscrimina,
      totalSaldo: resumen.totalSaldo,
      totalPositivo: resumen.totalPositivo,
      totalNegativo: resumen.totalNegativo,
      terceros: resumen.terceros,
      filas: resumen.filas,
    });
  } catch (err) {
    // Degradación: payload vacío + aviso, nunca un 500 que tumbe la vista.
    const mensaje = err instanceof HgiError ? `HgiError ${err.codigo}: ${err.message}` : (err as Error).message;
    console.error(`[clases] falló: ${mensaje}`);
    return NextResponse.json({
      ok: true,
      anyo: null,
      porClase: [],
      porBanco: [],
      bancoDiscrimina: false,
      totalSaldo: 0,
      totalPositivo: 0,
      totalNegativo: 0,
      terceros: 0,
      filas: 0,
      cached: false,
      stale: false,
      aviso: `Composición de cartera no disponible (${mensaje}).`,
    });
  }
}
