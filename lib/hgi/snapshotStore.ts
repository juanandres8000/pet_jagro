import { getSql as getDb } from '../pg';

/**
 * Caché read-through generalizada en Postgres (tabla keyed-by-dataset).
 * Equivale a migrations/003_hgi_snapshot.sql. Sirve para cachear distintos
 * datasets (catálogo, clientes, …) con el mismo patrón TTL + serve-stale.
 */

export type Dataset = 'catalog' | 'clients' | 'pedidos' | 'cartera';

export interface Snapshot<T> {
  data: T[];
  builtAt: Date;
  sourceCounts: Record<string, unknown> | null;
}

let tableReady = false;
async function ensureSnapshotTable(): Promise<void> {
  if (tableReady) return;
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS hgi_snapshot (
      dataset       TEXT PRIMARY KEY,
      data          JSONB,
      built_at      TIMESTAMPTZ,
      source_counts JSONB
    )
  `;
  tableReady = true;
}

/** Lee el snapshot de un dataset. Devuelve null si no hay datos guardados. */
export async function readSnapshot<T>(dataset: Dataset): Promise<Snapshot<T> | null> {
  await ensureSnapshotTable();
  const sql = getDb();
  // postgres.js decodifica timestamptz a Date (el driver de Neon devolvía string).
  // new Date(...) acepta ambos, pero el tipo refleja lo que llega de verdad.
  const rows = (await sql`
    SELECT data, built_at, source_counts FROM hgi_snapshot WHERE dataset = ${dataset}
  `) as unknown as Array<{ data: unknown; built_at: string | Date | null; source_counts: unknown }>;

  const row = rows[0];
  if (!row || !row.data || !row.built_at || !Array.isArray(row.data)) return null;
  return {
    data: row.data as T[],
    builtAt: new Date(row.built_at),
    sourceCounts: (row.source_counts as Record<string, unknown> | null) ?? null,
  };
}

/** Guarda (upsert) el snapshot de un dataset con built_at = ahora. */
export async function writeSnapshot<T>(
  dataset: Dataset,
  data: T[],
  sourceCounts: Record<string, unknown>,
): Promise<Date> {
  await ensureSnapshotTable();
  const sql = getDb();
  // sql.json() — NO `${JSON.stringify(x)}::jsonb`. postgres.js serializa el string
  // otra vez, así que ese patrón guarda un jsonb de tipo "string" (doble
  // codificación) en vez de un array. readSnapshot exige Array.isArray(data), así
  // que la caché fallaba SIEMPRE y cada request reconstruía contra HGINet.
  // Con el driver de Neon el patrón viejo sí producía un array; es un cambio de
  // comportamiento del driver que tsc y next build no detectan.
  const rows = (await sql`
    INSERT INTO hgi_snapshot (dataset, data, built_at, source_counts)
    VALUES (${dataset}, ${sql.json(data as never)}, NOW(), ${sql.json(sourceCounts as never)})
    ON CONFLICT (dataset) DO UPDATE
      SET data = EXCLUDED.data,
          built_at = EXCLUDED.built_at,
          source_counts = EXCLUDED.source_counts
    RETURNING built_at
  `) as unknown as Array<{ built_at: string | Date }>;
  return new Date(rows[0].built_at);
}
