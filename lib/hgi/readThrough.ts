import { readSnapshot, writeSnapshot, type Dataset, type Snapshot } from './snapshotStore';

/**
 * Read-through genérico con TTL y serve-stale, compartido por los datasets.
 * - Snapshot fresco (built_at dentro del TTL) → se sirve de Supabase (rápido).
 * - Vencido/inexistente → ejecuta build(), guarda y sirve.
 * - build() falla pero hay snapshot viejo → sirve el viejo con stale=true.
 * - build() falla y no hay snapshot → relanza (la route decide el status).
 *
 * ============ PRESUPUESTO DE TIEMPO: por qué existe ============
 *
 * El serve-stale de arriba sólo funciona si build() TERMINA — bien o mal. Si el
 * rebuild se come el `maxDuration` de la ruta, Vercel mata el lambda ANTES de que
 * este código pueda degradar, y el usuario recibe un **504 mudo** aunque la BD
 * tenga un snapshot perfectamente servible.
 *
 * Se manifestó dos veces:
 *  - /api/clientes: rebuild inline tras un cron fallido, contra maxDuration=30.
 *  - /api/recaudo: ~25 min de 504 mientras HGINet estaba cargado. El rebuild que
 *    normalmente tarda 50s se pasó de los 300s. El snapshot estaba intacto todo
 *    el tiempo y /api/vendedores (que lo lee directo) seguía respondiendo 200.
 *
 * El fix: la ruta pasa su `maxDuration` y aquí se corre el build contra un
 * DEADLINE = maxDuration − margen. Si vence, se aborta la espera y se sirve el
 * snapshot anterior con stale=true. **Mientras exista snapshot previo el usuario
 * nunca recibe 504.** Sin snapshot previo sí falla, pero con un error explícito
 * de timeout en vez de un corte mudo.
 *
 * CLAVE: al abortar NO se llama writeSnapshot. Un build a medias podría traer el
 * 80% de las filas y pasar el guard de ratio (0.5), escribiendo un snapshot
 * parcial que parece bueno. Por eso el resultado del build perdedor se descarta
 * entero: writeSnapshot sólo se invoca si build() ganó la carrera.
 *
 * ==============================================================
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

export interface ReadThroughOpts {
  /** `maxDuration` de la ruta, en segundos. Sin esto no hay presupuesto. */
  maxDurationSec: number;
  /** Margen de seguridad como fracción del maxDuration. Default 0,2 (20%). */
  margen?: number;
}

/** Margen por defecto: 20% del maxDuration reservado para responder. */
const MARGEN_DEFECTO = 0.2;
/** Presupuesto mínimo: por debajo de esto no vale la pena ni intentar. */
const PRESUPUESTO_MIN_MS = 2_000;

/** Error tipado del deadline, para distinguirlo de un fallo del build. */
export class RebuildTimeout extends Error {
  constructor(readonly ms: number) {
    super(`rebuild abortado por presupuesto de tiempo (${Math.round(ms / 1000)}s)`);
    this.name = 'RebuildTimeout';
  }
}

/**
 * Corre `p` con un límite de tiempo. Si vence, rechaza con RebuildTimeout y el
 * resultado de `p` se descarta — nunca se escribe.
 */
function conPresupuesto<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new RebuildTimeout(ms)), ms);
  });
  // Si el build termina DESPUÉS de perder la carrera, su rechazo ya está manejado
  // por Promise.race; este catch lo deja explícito para que nadie lo convierta en
  // un unhandled rejection al refactorizar. Un unhandled rejection mata el lambda
  // (visto: "Unhandled Rejection ... exit status 128" en los logs del cron).
  p.catch(() => {});
  return Promise.race([p, limite]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function readThrough<T>(
  dataset: Dataset,
  ttlMs: number,
  build: () => Promise<BuildResult<T>>,
  opts?: ReadThroughOpts,
): Promise<ReadThroughResult<T>> {
  // Se cronometra desde aquí. Lo que la ruta gastó antes (boot, parseo de query)
  // es despreciable y lo absorbe el margen.
  const t0 = Date.now();

  let snap: Snapshot<T> | null = null;
  try {
    snap = await readSnapshot<T>(dataset);
  } catch {
    snap = null; // si la BD falla en la lectura, intentamos reconstruir igual
  }

  if (snap && Date.now() - snap.builtAt.getTime() < ttlMs) {
    return { snapshot: snap, cached: true, stale: false };
  }

  // Presupuesto: maxDuration menos el margen, menos lo ya consumido leyendo el
  // snapshot. Sin opts no hay límite (comportamiento anterior).
  const presupuestoMs = opts
    ? Math.round(opts.maxDurationSec * 1000 * (1 - (opts.margen ?? MARGEN_DEFECTO))) - (Date.now() - t0)
    : null;

  try {
    const promesa = build();
    const built =
      presupuestoMs !== null && presupuestoMs >= PRESUPUESTO_MIN_MS
        ? await conPresupuesto(promesa, presupuestoMs)
        : await promesa;

    // writeSnapshot devuelve null cuando su guard de tamaño rechaza la escritura:
    // el build trajo menos del ratio mínimo de las filas que ya había (0 filas es
    // el extremo). Ese build NO se sirve — se sirve el snapshot bueno marcado
    // stale, igual que si el build hubiera lanzado. Sin esto la ruta devolvería la
    // data degradada del build aunque la BD conserve la buena, y el guard no
    // serviría de nada de cara al usuario.
    const builtAt = await writeSnapshot(dataset, built.data, built.sourceCounts);
    if (builtAt === null) {
      const mensaje =
        `El rebuild de "${dataset}" no pasó el guard de tamaño (devolvió ${built.data.length} filas); ` +
        'se conserva y sirve el snapshot anterior.';
      if (snap) return { snapshot: snap, cached: true, stale: true, rebuildError: mensaje };
      throw new Error(mensaje);
    }

    return {
      snapshot: { data: built.data, builtAt, sourceCounts: built.sourceCounts },
      cached: false,
      stale: false,
    };
  } catch (err) {
    const esTimeout = err instanceof RebuildTimeout;

    if (esTimeout) {
      console.error(
        `[readThrough] rebuild de ${dataset} abortado a los ${Math.round((Date.now() - t0) / 1000)}s, ` +
          (snap
            ? `sirviendo snapshot de ${snap.data.length} filas`
            : 'y NO hay snapshot previo que servir'),
      );
    }

    if (snap) {
      return {
        snapshot: snap,
        cached: true,
        stale: true,
        rebuildError: esTimeout ? `timeout: ${(err as RebuildTimeout).message}` : (err as Error).message,
      };
    }
    // Sin snapshot previo no hay nada que servir. Se relanza con mensaje
    // explícito: la ruta responde su degradación, no un 504 mudo.
    throw err;
  }
}

/** TTL en ms desde una env var de minutos (con default). */
export function ttlMsFromEnv(envVar: string, defaultMin: number): number {
  const min = Number(process.env[envVar]);
  return (Number.isFinite(min) && min > 0 ? min : defaultMin) * 60 * 1000;
}
