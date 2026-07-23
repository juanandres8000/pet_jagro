import { getSql } from './pg';

// Lazy connection - solo se conecta cuando se usa.
// Delega en lib/pg.ts (postgres.js, cliente memoizado). Antes usaba
// @neondatabase/serverless; Neon quedó abandonado en la migración a Supabase.
export function getDb() {
  return getSql();
}
