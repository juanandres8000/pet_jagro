import { NextResponse } from 'next/server';
import { HgiError } from '@/lib/hgi/client';
import { buildClientsSnapshot } from '@/lib/hgi/clientes';
import { readThrough, ttlMsFromEnv } from '@/lib/hgi/readThrough';
import type { Cliente } from '@/lib/hgi/mappers/terceros';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Un rebuild de Terceros contra HGINet tarda varios segundos.
export const maxDuration = 30;

/**
 * Clientes (Terceros de HGINet) con caché read-through en Neon (dataset 'clients').
 * Sirve de Neon dentro del TTL; reconstruye al vencer; serve-stale si el rebuild falla.
 * Degradación: si Terceros falla y no hay snapshot previo, devuelve lista vacía +
 * aviso (NO un 500), para que la vista no se caiga.
 */
export async function GET() {
  try {
    const rt = await readThrough<Cliente>(
      'clients',
      ttlMsFromEnv('HGI_CLIENTS_TTL_MIN', 15),
      buildClientsSnapshot,
    );

    const clientes = rt.snapshot.data;
    return NextResponse.json({
      ok: true,
      count: clientes.length,
      clientes,
      fuente: rt.snapshot.sourceCounts?.fuente ?? null,
      tiposCliente: rt.snapshot.sourceCounts?.tiposCliente ?? {},
      cached: rt.cached,
      stale: rt.stale,
      built_at: rt.snapshot.builtAt.toISOString(),
      ...(rt.rebuildError ? { rebuildError: rt.rebuildError } : {}),
    });
  } catch (err) {
    // Sin snapshot previo y Terceros falló → degradación: lista vacía + aviso, no 500.
    const mensaje = err instanceof HgiError ? `HgiError ${err.codigo}: ${err.message}` : (err as Error).message;
    return NextResponse.json({
      ok: true,
      count: 0,
      clientes: [],
      tiposCliente: {},
      cached: false,
      stale: false,
      aviso: `Clientes no disponibles (${mensaje}).`,
    });
  }
}
