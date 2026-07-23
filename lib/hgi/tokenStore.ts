import { getSql as getDb } from '../pg';

/**
 * Caché/candado compartido del token de HGINet en Postgres (Supabase).
 *
 * HGINet solo permite un token vigente por usuario, y las funciones serverless
 * de Vercel no comparten memoria. Esta tabla single-row (id = 1) es el punto
 * único de verdad para el token entre todas las invocaciones.
 */

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

/** Lee el token cacheado. Devuelve null si no hay token guardado. */
export async function readToken(): Promise<StoredToken | null> {
  await ensureTokenTable();
  const sql = getDb();
  // timestamptz llega como Date con postgres.js (el driver de Neon devolvía string).
  const rows = (await sql`
    SELECT jwt, expires_at FROM hgi_token WHERE id = 1
  `) as unknown as Array<{ jwt: string | null; expires_at: string | Date | null }>;

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
