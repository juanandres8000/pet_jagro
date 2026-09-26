import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

/**
 * Cliente de Supabase para Server Components, Server Actions y Route Handlers.
 * Uno nuevo por request: el cliente guarda estado de la sesión y de las cabeceras
 * anti-caché que acompañan a la primera escritura de cookies.
 *
 * Next 14: `cookies()` es síncrono.
 */
export function createClient() {
  const cookieStore = cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Llamado desde un Server Component, donde las cookies son de sólo
          // lectura. No pasa nada: el middleware ya refrescó la sesión.
        }
      },
    },
  });
}
