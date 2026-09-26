'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { destinoSeguro } from '@/lib/auth/destino';

export interface LoginState {
  error: string | null;
}

const ERROR_GENERICO = 'Correo o contraseña incorrectos';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  if (!email || !password) return { error: 'Ingrese su correo y su contraseña.' };
  if (!EMAIL_RE.test(email) || email.length > 254) return { error: 'Ingrese un correo válido.' };

  const supabase = createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  // Mismo mensaje para usuario inexistente y contraseña errada: no se revela cuál falló.
  if (error) return { error: ERROR_GENERICO };

  redirect(destinoSeguro(formData.get('next')));
}

export async function logout(): Promise<void> {
  const supabase = createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
