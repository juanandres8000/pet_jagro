import { NextResponse } from 'next/server';
import { HgiError } from '@/lib/hgi/client';
import { buildCarteraSnapshot } from '@/lib/hgi/cartera';
import { readThrough, ttlMsFromEnv } from '@/lib/hgi/readThrough';
import type { CarteraCliente, CarteraResumen } from '@/lib/hgi/mappers/cartera';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// El rebuild de Cartera contra HGINet es lento (~22s) + join + escritura.
// El mismo valor alimenta el presupuesto de tiempo de readThrough,
// así que no pueden desincronizarse.
const MAX_DURATION_SEC = 60;
export const maxDuration = MAX_DURATION_SEC;

/**
 * Cartera (aging) con caché read-through en Neon (dataset 'cartera').
 * Sirve de Neon dentro del TTL; reconstruye al vencer; serve-stale si el rebuild
 * falla. Devuelve el resumen de aging precalculado (KPIs, buckets, top deudores)
 * + el agregado por tercero (para lookups de saldo en otras vistas).
 * Degradación: sin snapshot previo y HGINet falla → payload vacío + aviso, no 500.
 */
export async function GET() {
  try {
    const rt = await readThrough<CarteraCliente>(
      'cartera',
      ttlMsFromEnv('HGI_CARTERA_TTL_MIN', 30),
      buildCarteraSnapshot,
      { maxDurationSec: MAX_DURATION_SEC },
    );

    const resumen = (rt.snapshot.sourceCounts ?? {}) as unknown as CarteraResumen;
    return NextResponse.json({
      ok: true,
      resumen,
      clientes: rt.snapshot.data, // agregado por tercero
      count: rt.snapshot.data.length,
      cached: rt.cached,
      stale: rt.stale,
      built_at: rt.snapshot.builtAt.toISOString(),
      ...(rt.rebuildError ? { rebuildError: rt.rebuildError } : {}),
    });
  } catch (err) {
    const mensaje = err instanceof HgiError ? `HgiError ${err.codigo}: ${err.message}` : (err as Error).message;
    return NextResponse.json({
      ok: true,
      resumen: null,
      clientes: [],
      count: 0,
      cached: false,
      stale: false,
      aviso: `Cartera no disponible (${mensaje}).`,
    });
  }
}
