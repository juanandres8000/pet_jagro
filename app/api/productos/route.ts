import { NextResponse } from 'next/server';
import { HgiError } from '@/lib/hgi/client';
import { buildCatalogSnapshot } from '@/lib/hgi/catalog';
import { readThrough, ttlMsFromEnv } from '@/lib/hgi/readThrough';
import type { ProductoDTO } from '@/lib/hgi/mappers/productos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Un rebuild contra HGINet tarda ~12-22s; el default de 10s no alcanza.
export const maxDuration = 30;

interface CatalogInventario {
  disponible?: boolean;
  fuente?: string | null;
  aviso?: string | null;
}

/**
 * Catálogo cruzado con caché read-through en Neon (dataset 'catalog').
 * Sirve de Neon dentro del TTL; reconstruye al vencer; serve-stale si el rebuild falla.
 */
export async function GET() {
  try {
    const rt = await readThrough<ProductoDTO>(
      'catalog',
      ttlMsFromEnv('HGI_CATALOG_TTL_MIN', 15),
      buildCatalogSnapshot,
    );

    const products = rt.snapshot.data;
    const inv = (rt.snapshot.sourceCounts?.inventario as CatalogInventario) ?? {};

    return NextResponse.json({
      ok: true,
      count: products.length,
      products,
      inventario: {
        disponible: inv.disponible ?? false,
        fuente: inv.fuente ?? null,
        aviso: inv.aviso ?? null,
        productosConStock: products.filter((p) => p.stock > 0).length,
      },
      cached: rt.cached,
      stale: rt.stale,
      built_at: rt.snapshot.builtAt.toISOString(),
      ...(rt.rebuildError ? { rebuildError: rt.rebuildError } : {}),
    });
  } catch (err) {
    const mensaje = err instanceof HgiError ? `HgiError ${err.codigo}: ${err.message}` : (err as Error).message;
    const status = err instanceof HgiError ? 502 : 500;
    return NextResponse.json({ ok: false, tipo: err instanceof HgiError ? 'HgiError' : 'Error', mensaje }, { status });
  }
}
