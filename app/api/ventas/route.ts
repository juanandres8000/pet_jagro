import { NextResponse } from 'next/server';
import { HgiError } from '@/lib/hgi/client';
import { buildVentasSnapshot } from '@/lib/hgi/ventas';
import { readThrough, ttlMsFromEnv } from '@/lib/hgi/readThrough';
import type { VentaLinea, VentasResumen } from '@/lib/hgi/mappers/ventas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// El rebuild pagina ~11 ventanas de 5 días contra HGINet con concurrencia 2.
// Es el dataset más lento del sistema; en la práctica lo puebla el cron y esta
// ruta sirve del snapshot.
export const maxDuration = 300;

/**
 * Ventas y rentabilidad con caché read-through (dataset 'ventas').
 * Sirve el resumen precalculado (totales del mes, comparativo vs mes anterior,
 * serie diaria, rankings) + las líneas crudas del mes corriente.
 *
 * `?lineas=1` incluye las líneas; por defecto NO se envían: son ~16k por mes y
 * la vista de Gerencia sólo consume el resumen.
 *
 * Degradación: sin snapshot previo y HGINet falla → payload vacío + aviso, no 500.
 */
export async function GET(req: Request) {
  const incluirLineas = new URL(req.url).searchParams.get('lineas') === '1';
  try {
    const rt = await readThrough<VentaLinea>(
      'ventas',
      ttlMsFromEnv('HGI_VENTAS_TTL_MIN', 60),
      buildVentasSnapshot,
    );

    const resumen = (rt.snapshot.sourceCounts ?? {}) as unknown as VentasResumen;
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
      aviso: `Ventas no disponibles (${mensaje}).`,
    });
  }
}
