import { readSnapshot, writeSnapshot, type Dataset, type Snapshot } from './snapshotStore';

/**
 * Read-through genérico con TTL y serve-stale, compartido por los datasets.
 * - Snapshot fresco (built_at dentro del TTL) → se sirve de Neon (rápido).
 * - Vencido/inexistente → ejecuta build(), guarda y sirve.
 * - build() falla pero hay snapshot viejo → sirve el viejo con stale=true.
 * - build() falla y no hay snapshot → relanza (la route decide el status).
 */

export interface ReadThroughResult<T> {
  snapshot: Snapshot<T>;
  cached: boolean;
  stale: boolean;
  rebuildError?: string;
}

export interface BuildResult<T> {
  data: T[];
  sourceCounts: Record<string, unknown>;
}

export async function readThrough<T>(
  dataset: Dataset,
  ttlMs: number,
  build: () => Promise<BuildResult<T>>,
): Promise<ReadThroughResult<T>> {
  let snap: Snapshot<T> | null = null;
  try {
    snap = await readSnapshot<T>(dataset);
  } catch {
    snap = null; // si Neon falla en la lectura, intentamos reconstruir igual
  }

  if (snap && Date.now() - snap.builtAt.getTime() < ttlMs) {
    return { snapshot: snap, cached: true, stale: false };
  }

  try {
    const built = await build();
    const builtAt = await writeSnapshot(dataset, built.data, built.sourceCounts);
    return {
      snapshot: { data: built.data, builtAt, sourceCounts: built.sourceCounts },
      cached: false,
      stale: false,
    };
  } catch (err) {
    if (snap) {
      return { snapshot: snap, cached: true, stale: true, rebuildError: (err as Error).message };
    }
    throw err; // sin snapshot previo: no hay nada que servir
  }
}

/** TTL en ms desde una env var de minutos (con default). */
export function ttlMsFromEnv(envVar: string, defaultMin: number): number {
  const min = Number(process.env[envVar]);
  return (Number.isFinite(min) && min > 0 ? min : defaultMin) * 60 * 1000;
}
