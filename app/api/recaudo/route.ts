import { NextResponse } from 'next/server';
import { HgiError } from '@/lib/hgi/client';
import { buildRecaudoSnapshot } from '@/lib/hgi/recaudo';
import { readThrough, ttlMsFromEnv } from '@/lib/hgi/readThrough';
import type { RecaudoLinea, RecaudoResumen } from '@/lib/hgi/mappers/recaudo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Pagina el mes corriente en ventanas de 5 días contra HGINet.
// El mismo valor alimenta el presupuesto de tiempo de readThrough,
// así que no pueden desincronizarse.
const MAX_DURATION_SEC = 300;
export const maxDuration = MAX_DURATION_SEC;

/**
 * Recaudo del mes con caché read-through (dataset 'recaudo').
 * Sirve el resumen precalculado (total recaudado, ajustes que NO son caja,
 * por día, por vendedor, por concepto, top clientes).
 *
 * `?lineas=1` incluye las aplicaciones de pago crudas; por defecto no viajan.
 */
export async function GET(req: Request) {
  const incluirLineas = new URL(req.url).searchParams.get('lineas') === '1';
  try {
    const rt = await readThrough<RecaudoLinea>(
      'recaudo',
      ttlMsFromEnv('HGI_RECAUDO_TTL_MIN', 60),
      buildRecaudoSnapshot,
      { maxDurationSec: MAX_DURATION_SEC },
    );

    const resumen = (rt.snapshot.sourceCounts ?? {}) as unknown as RecaudoResumen;
    return NextResponse.json({
      ok: true,
      resumen,
      count: rt.snapshot.data.length,
      cached: rt.cached,
      stale: rt.stale,
      built_at: rt.snapshot.builtAt.toISOString(),
      ...(incluirLineas ? { lineas: rt.snapshot.data } : {}),
      ...(rt.rebuildError ? { rebuildError: rt.rebuildError } : {}),
    });
  } catch (err) {
    const mensaje = err instanceof HgiError ? `HgiError ${err.codigo}: ${err.message}` : (err as Error).message;
    return NextResponse.json({
      ok: true,
      resumen: null,
      count: 0,
      cached: false,
      stale: false,
      aviso: `Recaudo no disponible (${mensaje}).`,
    });
  }
}
