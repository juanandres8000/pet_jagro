import { NextResponse } from 'next/server';
import { HgiError } from '@/lib/hgi/client';
import { buildClasesSnapshot } from '@/lib/hgi/clases';
import { readThrough, ttlMsFromEnv } from '@/lib/hgi/readThrough';
import { aggregateClases, type ClaseSaldo, type ClasesResumen } from '@/lib/hgi/mappers/clases';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// El build es UNA llamada a ResumenPorClases: ~32s medidos para el año completo.
// 60 da margen para un lambda lento sin acercarse al techo.
export const maxDuration = 60;

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
  const orden = sp.get('orden') === 'nombre' ? 'nombre' : 'saldo';
  const page = Math.max(1, Number(sp.get('page')) || 1);
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(5, Number(sp.get('pageSize')) || PAGE_SIZE_DEFAULT));

  try {
    const rt = await readThrough<ClaseSaldo>(
      'clases',
      ttlMsFromEnv('HGI_CLASES_TTL_MIN', 60),
      buildClasesSnapshot,
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

    // ---- Drill: terceros de una clase ----
    if (clase !== null) {
      const deLaClase = filas.filter((f) => f.codigoClase === clase);
      const ordenadas = [...deLaClase].sort((a, b) =>
        orden === 'nombre' ? a.nombreTercero.localeCompare(b.nombreTercero, 'es') : b.saldo - a.saldo,
      );
      const total = ordenadas.length;
      const maxPage = Math.max(1, Math.ceil(total / pageSize));
      const pageSafe = Math.min(page, maxPage);
      const grupo = resumen.porClase.find((c) => c.codigo === clase) ?? null;

      return NextResponse.json({
        ...meta,
        clase,
        nombreClase: grupo?.nombre ?? deLaClase[0]?.nombreClase ?? clase,
        grupo,
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
