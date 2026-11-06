/**
 * Quién puede registrar y anular pagos del precio cero. El resto de usuarios con
 * sesión sólo los ve. Jotagro definió (nov-2026): Viviana (facturación) y la
 * contadora.
 *
 * Lista = REGISTRADORES_BASE + la variable DESCUENTOS_REGISTRADORES (correos
 * separados por coma) en Vercel, para sumar gente sin desplegar código.
 */
const REGISTRADORES_BASE = ['facturacion@jotagro.com'];

const normalizar = (e: string) => e.trim().toLowerCase();

export function registradores(env: string | undefined = process.env.DESCUENTOS_REGISTRADORES): Set<string> {
  const extra = (env ?? '').split(',').map(normalizar).filter((e) => e.includes('@'));
  return new Set([...REGISTRADORES_BASE.map(normalizar), ...extra]);
}

export function puedeRegistrarPagos(email: string | null | undefined, env?: string): boolean {
  if (!email) return false;
  return registradores(env).has(normalizar(email));
}
