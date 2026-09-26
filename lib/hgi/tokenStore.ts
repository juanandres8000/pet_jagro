import { getSql as getDb, conTimeout } from '../pg';

/** Tope de cada query del store: son lecturas/escrituras de una fila. */
const QUERY_MS = 10_000;

/**
 * Cola en serie para TODAS las queries del token dentro del proceso.
 *
 * El cliente es `max: 1` sobre el pooler en transaction mode: dos queries a la
 * vez sobre esa conexión la cuelgan sin error (trampa 2 del pooler, CLAUDE.md).
 * Los builders llaman a HGINet en paralelo (ventas 2, recaudo 12, catalog y
 * clients con Promise.all) y cada llamada puede leer, renovar o invalidar el
 * token — p.ej. dos 401 simultáneos invalidaban a la vez. Con la cola, nunca hay
 * dos queries del token en vuelo.
 */
let cola: Promise<unknown> = Promise.resolve();
function enSerie<T>(fn: () => Promise<T>): Promise<T> {
  const r = cola.then(fn, fn);
  cola = r.catch(() => {});
  return r;
}

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
//
/**
 * Se memoiza la PROMESA en vuelo, no un booleano — ver CLAUDE.md
 * § "Trampas del pooler".
 *
 * Con un flag, dos llamadas concurrentes ven `false` las dos y emiten dos
 * CREATE TABLE; cada uno pide ACCESS EXCLUSIVE y, sobre la única conexión del
 * cliente (max: 1), se bloquean entre sí hasta el timeout. Aquí es especialmente
 * fácil de disparar: getValidToken corre desde cada builder, y el refresh de
 * todos los datasets los invoca en secuencia. Está latente sólo porque hgi_token
 * ya existe.
 */
let tablePromise: Promise<void> | null = null;
function ensureTokenTable(): Promise<void> {
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
    CREATE TABLE IF NOT EXISTS hgi_token (
      id         INTEGER PRIMARY KEY DEFAULT 1,
      jwt        TEXT,
      expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT hgi_token_single_row CHECK (id = 1)
    )
  `;
  await sql`INSERT INTO hgi_token (id, jwt, expires_at) VALUES (1, NULL, NULL) ON CONFLICT (id) DO NOTHING`;
}

/** Lee el token cacheado. Devuelve null si no hay token guardado. */
export function readToken(): Promise<StoredToken | null> {
  return enSerie(async () => {
    await ensureTokenTable();
    const sql = getDb();
    // timestamptz llega como Date con postgres.js (el driver de Neon devolvía string).
    const rows = (await conTimeout(
      sql`SELECT jwt, expires_at FROM hgi_token WHERE id = 1`,
      QUERY_MS,
      'readToken',
    )) as unknown as Array<{ jwt: string | null; expires_at: string | Date | null }>;

    const row = rows[0];
    if (!row || !row.jwt || !row.expires_at) return null;
    return { jwt: row.jwt, expiresAt: new Date(row.expires_at) };
  });
}

/** Guarda (upsert) el token en la fila única de Neon. */
export function writeToken(jwt: string, expiresAt: Date): Promise<void> {
  return enSerie(async () => {
    await ensureTokenTable();
    const sql = getDb();
    await conTimeout(
      sql`
        INSERT INTO hgi_token (id, jwt, expires_at, updated_at)
        VALUES (1, ${jwt}, ${expiresAt.toISOString()}, NOW())
        ON CONFLICT (id) DO UPDATE
          SET jwt = EXCLUDED.jwt,
              expires_at = EXCLUDED.expires_at,
              updated_at = NOW()
      `,
      QUERY_MS,
      'writeToken',
    );
  });
}

/**
 * Invalida el token cacheado (p.ej. tras un 401 server-side), pero SOLO si la
 * fila sigue conteniendo el JWT que falló: **compare-and-swap**.
 *
 * El `WHERE jwt = ${failedJwt}` NO es cosmético. HGINet permite un solo token
 * vigente por usuario y esta fila es compartida por todos los lambdas. El UPDATE
 * incondicional anterior permitía esta secuencia:
 *   1. Lambda A renueva → escribe T2. HGINet invalida T1.
 *   2. Lambda B, en vuelo con T1, recibe 401 y borraba T2 — un token VÁLIDO.
 *   3. B re-autentica → HGINet responde "El Token aún se encuentra vigente"
 *      (T2 sigue vivo) y rehúsa emitir otro.
 *   4. El store quedaba vacío y nadie podía autenticar hasta que T2 expirara:
 *      hasta 20 min en que todo rebuild contra HGINet fallaba.
 * Con el CAS, un lambda sólo puede invalidar el token que él mismo usó.
 *
 * @returns `true` si invalidó; `false` si otro lambda ya rotó el token (la fila
 * ya tiene uno más nuevo, así que no hay nada que invalidar).
 */
export function clearToken(failedJwt: string): Promise<boolean> {
  return enSerie(async () => {
    await ensureTokenTable();
    const sql = getDb();
    const rows = (await conTimeout(
      sql`
        UPDATE hgi_token
           SET jwt = NULL, expires_at = NULL, updated_at = NOW()
         WHERE id = 1 AND jwt = ${failedJwt}
        RETURNING id
      `,
      QUERY_MS,
      'clearToken',
    )) as unknown as Array<{ id: number }>;
    return rows.length > 0;
  });
}
