import { createClient } from '@/lib/supabase/server';
import { puedeRegistrarPagos } from './permisos';

/** Correo de la sesión actual (null sin sesión) y si puede registrar pagos. */
export async function sesionPagos(): Promise<{ email: string | null; puedeRegistrar: boolean }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const email = user?.email ?? null;
  return { email, puedeRegistrar: puedeRegistrarPagos(email) };
}
