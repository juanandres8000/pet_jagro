/**
 * Cierre de sesión por inactividad — constantes y helpers PUROS, sin imports.
 *
 * La lógica con estado (listeners, timer, modal, logout) vive en
 * `components/inactivity-guard.tsx`. Aquí sólo lo que se puede razonar sin DOM,
 * para que el formato y los umbrales queden en un solo lugar.
 * Adaptado de juanandres8000/espcontables (lib/inactivity.ts).
 */

/** Tiempo sin actividad tras el cual se cierra la sesión. */
export const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

/** Con este tiempo o menos por delante, el contador cambia de color y abre el modal. */
export const INACTIVITY_WARN_MS = 2 * 60 * 1000;

/** No se escribe `lastActivity` más seguido que esto; `mousemove` dispara a decenas de Hz. */
export const INACTIVITY_THROTTLE_MS = 1000;

/**
 * Clave de `localStorage` con el epoch (ms) de la última actividad. Es lo que
 * sincroniza pestañas: cada escritura dispara el evento `storage` en las demás.
 */
export const LAST_ACTIVITY_KEY = 'pj:lastActivity';

/** Milisegundos que quedan antes del cierre. Nunca negativo. */
export function remainingMs(lastActivity: number, now: number): number {
  return Math.max(0, INACTIVITY_TIMEOUT_MS - (now - lastActivity));
}

/** `mm:ss`, redondeando hacia arriba para que «00:01» no se pinte como «00:00» antes de tiempo. */
export function formatMmSs(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** Lee el valor guardado; `null` si no hay, no parsea o no es un epoch razonable. */
export function parseLastActivity(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
