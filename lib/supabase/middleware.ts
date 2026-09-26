import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/**
 * Refresca la sesión de Supabase en cada request y devuelve la respuesta que
 * lleva las cookies renovadas, junto con el usuario (o null).
 *
 * Patrón oficial de @supabase/ssr: NO poner código entre createServerClient y
 * getUser, y devolver SIEMPRE `response` (o copiar sus cookies) para que el
 * navegador reciba el token renovado.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers).forEach(([k, v]) => response.headers.set(k, v));
      },
    },
  });

  // getUser valida el JWT contra Supabase Auth; getSession sólo lee la cookie.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { response, user };
}
