'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export interface LoginState {
  error: string | null;
}

const ERROR_GENERICO = 'Correo o contraseña incorrectos';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Destino post-login a partir de ?next=. Sólo paths relativos del mismo sitio:
 * "//evil.com", "/\evil.com" o "https://…" caen en "/". Evita el open redirect.
 */
function destinoSeguro(next: FormDataEntryValue | null): string {
  const raw = typeof next === 'string' ? next : '';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  try {
    const base = 'http://x.invalid';
    const url = new URL(raw, base);
    if (url.origin !== base || url.pathname === '/login') return '/';
    return url.pathname + url.search + url.hash;
  } catch {
    return '/';
  }
}

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
