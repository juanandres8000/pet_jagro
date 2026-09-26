import postgres from 'postgres';

/**
 * Cliente Postgres compartido (postgres.js) — sustituye a @neondatabase/serverless.
 *
 * Por qué el cambio: Neon quedó abandonado; la BD es Supabase. El driver de Neon
 * hablaba HTTP (fetch) y era stateless, así que crear un cliente por llamada era
 * gratis. postgres.js abre conexiones TCP reales: crear un pool por invocación
 * agotaría el pooler. De ahí el memo a nivel de módulo — UN cliente por lambda.
 *
 * Config obligatoria para Supabase + Vercel serverless:
 *  - `prepare: false`: el pooler de Supabase (puerto 6543, modo transaction)
 *    NO soporta prepared statements. Sin esto los queries fallan con
 *    "prepared statement ... already exists".
 *  - `max: 1`: cada lambda es un proceso efímero que sirve una request a la vez;
 *    más de una conexión por instancia sólo consume cupo del pooler.
 *  - `idle_timeout`: suelta la conexión si la lambda queda caliente sin tráfico.
 *
 * La interfaz de uso es la misma que la de neon(): tagged template que devuelve
 * un array de filas — `await sql\`SELECT ...\`` sigue funcionando igual.
 *
 * Nota: ya no hace falta `fetchOptions: { cache: 'no-store' }`. Eso existía
 * porque el driver de Neon iba por fetch y Next.js cachea fetch por defecto;
 * sobre TCP no hay caché de Next que evitar.
 */

type Sql = ReturnType<typeof postgres>;

let client: Sql | null = null;

export function getSql(): Sql {
  if (client) return client;
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured');
  }
  client = postgres(process.env.DATABASE_URL, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return client;
}

/**
 * Descarta el cliente actual: el siguiente getSql() abre una conexión nueva.
 * Se usa cuando una query se queda sin respuesta (ver conTimeout).
 */
function descartarCliente(): void {
  const viejo = client;
  client = null;
  viejo?.end({ timeout: 1 }).catch(() => {});
}

/**
 * Query con timeout del lado del CLIENTE. Si no responde en `ms`, se cancela, se
 * descarta la conexión y se lanza un error: la ruta falla rápido en vez de
 * colgarse hasta el maxDuration de Vercel.
 *
 * Por qué no basta `statement_timeout`: el cuelgue que se vio en producción
 * (trampa 2 del pooler en CLAUDE.md) deja el backend en `active` /
 * `ClientRead` — la query YA terminó y Postgres espera al cliente. Ahí el
 * servidor no está ejecutando nada, así que `statement_timeout` nunca dispara.
 */
export async function conTimeout<T>(query: PromiseLike<T> & { cancel?: () => unknown }, ms: number, etiqueta: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        query.cancel?.();
      } catch {
        // la query pudo no haber arrancado; igual se descarta la conexión
      }
      descartarCliente();
      reject(new Error(`[pg] ${etiqueta}: sin respuesta en ${ms} ms, conexión descartada`));
    }, ms);
  });
  try {
    return await Promise.race([query, limite]);
  } finally {
    clearTimeout(timer);
  }
}
