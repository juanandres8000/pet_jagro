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
