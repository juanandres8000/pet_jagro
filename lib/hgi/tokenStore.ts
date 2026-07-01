import { neon } from '@neondatabase/serverless';

/**
 * Caché/candado compartido del token de HGINet en Neon.
 *
 * HGINet solo permite un token vigente por usuario, y las funciones serverless
 * de Vercel no comparten memoria. Esta tabla single-row (id = 1) es el punto
 * único de verdad para el token entre todas las invocaciones.
 */

// Conexión lazy (mismo patrón que lib/db.ts) para no romper el build.
// IMPORTANTE: cache: 'no-store'. El driver de Neon consulta vía fetch, y Next.js
// cachea fetch por defecto; sin esto, el token cacheado en BD se leería obsoleto
// (p.ej. una fila NULL inicial persistiría aunque la BD ya tenga token válido).
function getDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured');
  }
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: 'no-store' } });
}

export interface StoredToken {
  jwt: string;
  expiresAt: Date;
}

// Crea la tabla si no existe (init-on-use, igual que chat_feedback).
// Idempotente: equivale a migrations/001_hgi_token.sql.
let tableReady = false;
async function ensureTokenTable(): Promise<void> {
  if (tableReady) return;
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS hgi_token (
      id         INTEGER PRIMARY KEY DEFAULT 1,
      jwt        TEXT,
      expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT hgi_token_single_row CHECK (id = 1)
    )
  `;
  await sql`INSERT INTO hgi_token (id, jwt, expires_at) VALUES (1, NULL, NULL) ON CONFLICT (id) DO NOTHING`;
  tableReady = true;
}

/** Lee el token cacheado de Neon. Devuelve null si no hay token guardado. */
export async function readToken(): Promise<StoredToken | null> {
  await ensureTokenTable();
  const sql = getDb();
  const rows = (await sql`
    SELECT jwt, expires_at FROM hgi_token WHERE id = 1
  `) as Array<{ jwt: string | null; expires_at: string | null }>;

  const row = rows[0];
  if (!row || !row.jwt || !row.expires_at) return null;
  return { jwt: row.jwt, expiresAt: new Date(row.expires_at) };
}

/** Guarda (upsert) el token en la fila única de Neon. */
export async function writeToken(jwt: string, expiresAt: Date): Promise<void> {
  await ensureTokenTable();
  const sql = getDb();
  await sql`
    INSERT INTO hgi_token (id, jwt, expires_at, updated_at)
    VALUES (1, ${jwt}, ${expiresAt.toISOString()}, NOW())
    ON CONFLICT (id) DO UPDATE
      SET jwt = EXCLUDED.jwt,
          expires_at = EXCLUDED.expires_at,
          updated_at = NOW()
  `;
}

/** Invalida el token cacheado (p.ej. tras un 401 server-side). */
export async function clearToken(): Promise<void> {
  await ensureTokenTable();
  const sql = getDb();
  await sql`UPDATE hgi_token SET jwt = NULL, expires_at = NULL, updated_at = NOW() WHERE id = 1`;
}
