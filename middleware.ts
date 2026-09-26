import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

/**
 * Protege TODA la app, páginas y app/api/*, con la sesión de Supabase Auth.
 *
 * Públicas:
 *  - /login y /auth/* (callback de los enlaces de correo, definir contraseña):
 *    el propio flujo de acceso.
 *  - /api/hgi/refresh: lo llaman los crons de Vercel, que no tienen sesión. Se
 *    autentica solo con CRON_SECRET (GET) o x-hgi-refresh-secret (POST); aquí
 *    no se toca.
 *  - _next/static, _next/image, favicon e imágenes estáticas: fuera del matcher.
 *
 * Sin sesión: páginas → /login?next=<path>; APIs → 401 JSON.
 */
const esRefreshHgi = (path: string) => path === '/api/hgi/refresh' || path.startsWith('/api/hgi/refresh/');

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  // Ni siquiera se refresca sesión: los crons no traen cookies.
  if (esRefreshHgi(pathname)) return NextResponse.next();

  const { response, user } = await updateSession(request);

  // /auth/* es público y NUNCA se redirige aquí: el callback llega sin sesión
  // (la crea él) y /auth/definir-contrasena exige sesión por su cuenta. Sí pasa
  // por updateSession para que la sesión recién creada se mantenga fresca.
  if (pathname.startsWith('/auth/')) return response;

  if (pathname === '/login') {
    if (!user) return response;
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return conCookies(NextResponse.redirect(url), response);
  }

  if (user) return response;

  if (pathname.startsWith('/api/')) {
    return conCookies(NextResponse.json({ ok: false, mensaje: 'No autenticado' }, { status: 401 }), response);
  }

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return conCookies(NextResponse.redirect(url), response);
}

/** Copia las cookies (p.ej. una sesión caducada que se limpia) a la respuesta final. */
function conCookies(destino: NextResponse, origen: NextResponse) {
  origen.cookies.getAll().forEach((c) => destino.cookies.set(c));
  return destino;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
