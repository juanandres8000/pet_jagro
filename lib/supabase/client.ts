import { createBrowserClient } from '@supabase/ssr';

/**
 * Cliente de Supabase para componentes de cliente. Hoy no lo importa nadie: el
 * login y el logout van por server actions. Mientras siga sin usarse, la anon
 * key no viaja en el bundle del navegador.
 */
export function createClient() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
