/**
 * Destino tras autenticarse a partir de ?next=. Sólo paths relativos del mismo
 * sitio: "//evil.com", "/\evil.com" o "https://…" caen en "/". Evita el open
 * redirect. Lo comparten la server action de login y /auth/callback.
 */
export function destinoSeguro(next: unknown): string {
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
