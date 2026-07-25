import { getSql as getDb } from '../pg';

/**
 * Caché read-through generalizada en Postgres (tabla keyed-by-dataset).
 * Equivale a migrations/003_hgi_snapshot.sql. Sirve para cachear distintos
 * datasets (catálogo, clientes, …) con el mismo patrón TTL + serve-stale.
 */

export type Dataset = 'catalog' | 'clients' | 'pedidos' | 'cartera' | 'ventas' | 'recaudo' | 'clases';

export interface Snapshot<T> {
  data: T[];
  builtAt: Date;
  sourceCounts: Record<string, unknown> | null;
}

/**
 * Se memoiza la PROMESA en vuelo, no un booleano — ver la nota extensa en
 * lib/hgi/ventasMensualStore.ts y CLAUDE.md § "Trampas del pooler".
 *
 * Con un flag, dos llamadas concurrentes ven `false` las dos y emiten dos
 * CREATE TABLE; cada uno pide ACCESS EXCLUSIVE y, sobre la única conexión del
 * cliente (max: 1), se bloquean entre sí hasta el timeout. Aquí está latente
 * porque hgi_snapshot ya existe y el IF NOT EXISTS sale barato por NOTICE, pero
 * revienta en cualquier entorno nuevo (Preview con otra BD, restore, Postgres
 * local).
 */
let tablePromise: Promise<void> | null = null;
function ensureSnapshotTable(): Promise<void> {
  if (!tablePromise) {
    tablePromise = crearTabla().catch((err) => {
      tablePromise = null; // permite reintentar si falló
      throw err;
    });
  }
  return tablePromise;
}

async function crearTabla(): Promise<void> {
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS hgi_snapshot (
      dataset       TEXT PRIMARY KEY,
      data          JSONB,
      built_at      TIMESTAMPTZ,
      source_counts JSONB
    )
  `;
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

/**
 * Guarda (upsert) el snapshot de un dataset con built_at = ahora.
 *
 * GUARD CONTRA SNAPSHOTS VACÍOS — aplica a TODOS los datasets.
 * Un build que devuelve 0 filas NO sobreescribe un snapshot que ya tiene filas.
 * Devuelve `null` en ese caso, para que el llamador sirva el snapshot bueno.
 *
 * Por qué: un build puede vaciarse sin lanzar. Caso real (2026-07-25 03:50Z):
 * `Terceros/Obtener` falló, el fallback `ObtenerLista` devolvió los 6.160
 * terceros pero SIN CodigoTipoTercero, el filtro de tipos 1+7 los descartó todos
 * y `buildClientsSnapshot` retornó `data: []` tan campante. Se escribieron 0
 * filas encima de 4.001 buenas y la vista de Clientes quedó vacía en producción
 * ~19 min. El serve-stale de readThrough no pudo actuar porque no hubo
 * excepción: el build "tuvo éxito" devolviendo nada.
 *
 * Es la misma clase de bug que el clearToken incondicional: destruir estado
 * compartido bueno a partir de una lectura degradada. Y la solución es la misma
 * forma —una condición en el propio UPDATE— para que sea ATÓMICA: comprobar el
 * conteo antes en JS dejaría una ventana en la que otro lambda escribe data
 * buena y nosotros la pisamos igual.
 *
 * Un dataset legítimamente vacío (primer build, o tabla sin datos) sí se escribe:
 * la condición sólo protege cuando YA había filas.
 */
export async function writeSnapshot<T>(
  dataset: Dataset,
  data: T[],
  sourceCounts: Record<string, unknown>,
): Promise<Date | null> {
  await ensureSnapshotTable();
  const sql = getDb();
  // sql.json() — NO `${JSON.stringify(x)}::jsonb`. postgres.js serializa el string
  // otra vez, así que ese patrón guarda un jsonb de tipo "string" (doble
  // codificación) en vez de un array. readSnapshot exige Array.isArray(data), así
  // que la caché fallaba SIEMPRE y cada request reconstruía contra HGINet.
  // Con el driver de Neon el patrón viejo sí producía un array; es un cambio de
  // comportamiento del driver que tsc y next build no detectan.
  // El WHERE del DO UPDATE es el guard: sólo sobreescribe si la data nueva trae
  // filas, o si lo que había ya estaba vacío/nulo (nada que preservar).
  const rows = (await sql`
    INSERT INTO hgi_snapshot (dataset, data, built_at, source_counts)
    VALUES (${dataset}, ${sql.json(data as never)}, NOW(), ${sql.json(sourceCounts as never)})
    ON CONFLICT (dataset) DO UPDATE
      SET data = EXCLUDED.data,
          built_at = EXCLUDED.built_at,
          source_counts = EXCLUDED.source_counts
      WHERE jsonb_array_length(EXCLUDED.data) > 0
         OR hgi_snapshot.data IS NULL
         OR jsonb_typeof(hgi_snapshot.data) <> 'array'
         OR jsonb_array_length(hgi_snapshot.data) = 0
    RETURNING built_at
  `) as unknown as Array<{ built_at: string | Date }>;

  if (rows.length === 0) {
    // Rechazado por el guard. Se relee el conteo sólo en este camino (raro) para
    // que el log diga exactamente qué se preservó.
    const prev = (await sql`
      SELECT jsonb_array_length(data) AS filas FROM hgi_snapshot WHERE dataset = ${dataset}
    `) as unknown as Array<{ filas: number | null }>;
    console.error(
      `[snapshot] build de "${dataset}" devolvió 0 filas, snapshot anterior de ${prev[0]?.filas ?? '?'} filas preservado`,
    );
    return null;
  }

  return new Date(rows[0].built_at);
}
