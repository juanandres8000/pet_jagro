'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export interface DefinirState {
  error: string | null;
}

const MINIMO = 8;
/** bcrypt, que usa Supabase Auth, ignora lo que pase de 72 bytes. */
const MAXIMO = 72;

export async function definirContrasena(_prev: DefinirState, formData: FormData): Promise<DefinirState> {
  const password = String(formData.get('password') ?? '');
  const confirmar = String(formData.get('confirmar') ?? '');

  if (password.length < MINIMO) return { error: `La contraseña debe tener al menos ${MINIMO} caracteres.` };
  if (new TextEncoder().encode(password).length > MAXIMO) return { error: `La contraseña no puede superar ${MAXIMO} caracteres.` };
  if (password !== confirmar) return { error: 'Las contraseñas no coinciden.' };

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    if (error.code === 'same_password') return { error: 'La nueva contraseña debe ser distinta de la anterior.' };
    if (error.code === 'weak_password') return { error: 'La contraseña es demasiado débil. Use una más larga o variada.' };
    return { error: 'No se pudo guardar la contraseña. Intente de nuevo.' };
  }

  redirect('/');
}
