'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export interface CambiarState {
  error: string | null;
  ok: boolean;
}

const MINIMO = 10;
/** bcrypt, que usa Supabase Auth, ignora lo que pase de 72 bytes. */
const MAXIMO = 72;

/**
 * Cambio de contraseña del propio usuario, sólo con la anon key y su sesión.
 * Primero reautentica con la contraseña actual (signInWithPassword renueva la
 * sesión en las cookies; si falla, la sesión vigente no se toca) y luego
 * updateUser. La sesión sigue abierta al terminar.
 */
export async function cambiarContrasena(_prev: CambiarState, formData: FormData): Promise<CambiarState> {
  const actual = String(formData.get('actual') ?? '');
  const nueva = String(formData.get('nueva') ?? '');
  const confirmar = String(formData.get('confirmar') ?? '');

  if (!actual || !nueva || !confirmar) return { error: 'Complete los tres campos.', ok: false };

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) redirect('/login');

  const { error: errorActual } = await supabase.auth.signInWithPassword({ email: user.email, password: actual });
  if (errorActual) return { error: 'La contraseña actual no es correcta.', ok: false };

  if (nueva.length < MINIMO) return { error: `La nueva contraseña debe tener al menos ${MINIMO} caracteres.`, ok: false };
  if (new TextEncoder().encode(nueva).length > MAXIMO) return { error: `La nueva contraseña no puede superar ${MAXIMO} caracteres.`, ok: false };
  if (nueva === actual) return { error: 'La nueva contraseña debe ser distinta de la actual.', ok: false };
  if (nueva !== confirmar) return { error: 'La confirmación no coincide con la nueva contraseña.', ok: false };

  const { error } = await supabase.auth.updateUser({ password: nueva });
  if (error) {
    if (error.code === 'same_password') return { error: 'La nueva contraseña debe ser distinta de la actual.', ok: false };
    if (error.code === 'weak_password') return { error: 'La contraseña es demasiado débil. Use una más larga o variada.', ok: false };
    return { error: 'No se pudo cambiar la contraseña. Intente de nuevo.', ok: false };
  }

  return { error: null, ok: true };
}
