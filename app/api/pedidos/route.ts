import { NextResponse } from 'next/server';
import { HgiError } from '@/lib/hgi/client';
import { buildPedidosSnapshot } from '@/lib/hgi/pedidos';
import { readThrough, ttlMsFromEnv } from '@/lib/hgi/readThrough';
import type { Pedido } from '@/lib/hgi/mappers/pedidos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Un rebuild contra HGINet tarda varios segundos.
export const maxDuration = 30;

/**
 * Pedidos pendientes (core de picking) con caché read-through en Neon ('pedidos').
 * Sirve de Neon dentro del TTL; reconstruye al vencer; serve-stale si el rebuild falla.
 * Degradación: sin snapshot previo y Pedidos falla → lista vacía + aviso, no 500.
 */
export async function GET() {
  try {
    const rt = await readThrough<Pedido>(
      'pedidos',
      ttlMsFromEnv('HGI_PEDIDOS_TTL_MIN', 15),
      buildPedidosSnapshot,
    );

    const pedidos = rt.snapshot.data;
    return NextResponse.json({
      ok: true,
      count: pedidos.length,
      pedidos,
      fuentes: rt.snapshot.sourceCounts ?? {},
      cached: rt.cached,
      stale: rt.stale,
      built_at: rt.snapshot.builtAt.toISOString(),
      ...(rt.rebuildError ? { rebuildError: rt.rebuildError } : {}),
    });
  } catch (err) {
    const mensaje = err instanceof HgiError ? `HgiError ${err.codigo}: ${err.message}` : (err as Error).message;
    return NextResponse.json({
      ok: true,
      count: 0,
      pedidos: [],
      fuentes: {},
      cached: false,
      stale: false,
      aviso: `Pedidos no disponibles (${mensaje}).`,
    });
  }
}
