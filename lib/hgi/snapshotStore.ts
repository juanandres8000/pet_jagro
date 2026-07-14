import { neon } from '@neondatabase/serverless';

/**
 * Caché read-through generalizada en Neon (tabla keyed-by-dataset).
 * Equivale a migrations/003_hgi_snapshot.sql. Sirve para cachear distintos
 * datasets (catálogo, clientes, …) con el mismo patrón TTL + serve-stale.
 */

export type Dataset = 'catalog' | 'clients' | 'pedidos' | 'cartera';

// cache: 'no-store' — el driver de Neon usa fetch y Next.js lo cachea por defecto.
function getDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured');
  }
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: 'no-store' } });
}

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
  const rows = (await sql`
    SELECT data, built_at, source_counts FROM hgi_snapshot WHERE dataset = ${dataset}
  `) as Array<{ data: unknown; built_at: string | null; source_counts: unknown }>;

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
  const rows = (await sql`
    INSERT INTO hgi_snapshot (dataset, data, built_at, source_counts)
    VALUES (${dataset}, ${JSON.stringify(data)}::jsonb, NOW(), ${JSON.stringify(sourceCounts)}::jsonb)
    ON CONFLICT (dataset) DO UPDATE
      SET data = EXCLUDED.data,
          built_at = EXCLUDED.built_at,
          source_counts = EXCLUDED.source_counts
    RETURNING built_at
  `) as Array<{ built_at: string }>;
  return new Date(rows[0].built_at);
}
