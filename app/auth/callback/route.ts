import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { destinoSeguro } from '@/lib/auth/destino';

const DEFINIR_CONTRASENA = '/auth/definir-contrasena';
/** Tipos de enlace que llegan sin contraseña utilizable: hay que definirla. */
const PIDEN_CONTRASENA = new Set<string>(['invite', 'recovery']);

/**
 * Aterrizaje de los enlaces de correo de Supabase Auth. Dos formas:
 *
 *  - `?token_hash=…&type=invite|recovery|…` → verifyOtp. Es la que usan las
 *    invitaciones: las crea el administrador desde el dashboard, así que no hay
 *    code_verifier en el navegador del invitado y PKCE no sirve. Exige que la
 *    plantilla del correo apunte aquí (ver CLAUDE.md → "Usuarios e invitaciones").
 *  - `?code=…` → exchangeCodeForSession (PKCE), para flujos que inicie la propia
 *    app desde el navegador del usuario.
 *
 * Invite/recovery → /auth/definir-contrasena; lo demás → ?next= (sólo relativo) o /.
 * Enlace inválido o vencido → /login?error=enlace.
 *
 * Las cookies de la sesión nueva las escribe el cliente de servidor vía
 * cookies(), y Next las adjunta a la respuesta de redirect.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type');

  const supabase = createClient();
  let ok = false;
  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type: type as EmailOtpType, token_hash: tokenHash });
    ok = !error;
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    ok = !error;
  }

  if (!ok) return NextResponse.redirect(new URL('/login?error=enlace', origin));

  const destino = type && PIDEN_CONTRASENA.has(type) ? DEFINIR_CONTRASENA : destinoSeguro(searchParams.get('next'));
  return NextResponse.redirect(new URL(destino, origin));
}
