'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { GeistMono } from 'geist/font/mono';
import { logout } from '@/app/(auth)/login/actions';
import {
  INACTIVITY_THROTTLE_MS,
  INACTIVITY_WARN_MS,
  LAST_ACTIVITY_KEY,
  formatMmSs,
  parseLastActivity,
  remainingMs,
} from '@/lib/inactivity';

/**
 * Cierre de sesión por inactividad, con contador visible. Adaptado de
 * juanandres8000/espcontables (components/inactivity-guard.tsx) a Next 14 / React 18.
 *
 * `InactivityGuard` se monta en `app/(app)/layout.tsx`, así que sólo existe con
 * sesión: /login vive fuera del grupo `(app)`. Publica el tiempo restante por
 * contexto porque el contador se pinta en DOS sitios de AppShell (sidebar de
 * escritorio y barra móvil) con `<InactivityCountdown />`.
 *
 * - Cada actividad (mousemove/keydown/click/scroll/touchstart, y volver a la
 *   pestaña) escribe el epoch en `localStorage`, con throttle de 1 s. Esa
 *   escritura dispara `storage` en las demás pestañas, que adoptan el valor: la
 *   sesión es una sola aunque haya varias pestañas.
 * - Un tick de 1 s recalcula contra `Date.now()` —no acumula—, así que una
 *   pestaña dormida se pone al día sola al despertar.
 * - A 2:00 del cierre se abre el modal. Mientras está abierto la actividad
 *   pasiva NO reinicia: sólo «Continuar» (o actividad en otra pestaña).
 * - Al llegar a 0, o con «Cerrar sesión», se llama a la MISMA server action
 *   `logout()` del menú: signOut + redirect('/login').
 *
 * ⚠️ Alcance: esto cierra desde el cliente. Una pestaña cerrada no corre ningún
 * timer; la garantía del servidor es `sessions_inactivity_timeout` del proyecto
 * Supabase (Authentication → Sessions), que se configura aparte.
 */

const RestanteContext = createContext<{ remaining: number | null; warning: boolean }>({ remaining: null, warning: false });

export function InactivityGuard({ children }: { children: ReactNode }) {
  const [remaining, setRemaining] = useState<number | null>(null);
  const [, startTransition] = useTransition();
  const lastActivity = useRef<number>(0);
  const lastWrite = useRef<number>(0);
  const loggingOut = useRef(false);
  const warningRef = useRef(false);

  const doLogout = useCallback(() => {
    if (loggingOut.current) return;
    loggingOut.current = true;
    try {
      localStorage.removeItem(LAST_ACTIVITY_KEY);
    } catch {
      // Sin storage se cierra igual.
    }
    startTransition(() => {
      void logout();
    });
  }, []);

  /** Registra actividad: ref local + localStorage (para las demás pestañas). */
  const markActivity = useCallback((force = false) => {
    const now = Date.now();
    if (!force && now - lastWrite.current < INACTIVITY_THROTTLE_MS) return;
    lastWrite.current = now;
    lastActivity.current = now;
    try {
      localStorage.setItem(LAST_ACTIVITY_KEY, String(now));
    } catch {
      // idem
    }
    setRemaining(remainingMs(now, now));
  }, []);

  useEffect(() => {
    // Montar ES actividad: sin esto, un valor viejo en localStorage (sesión
    // anterior en el mismo navegador) cerraría la sesión recién abierta.
    markActivity(true);

    const tick = () => {
      const ms = remainingMs(lastActivity.current, Date.now());
      setRemaining(ms);
      if (ms <= 0) doLogout();
    };

    // Actividad pasiva: se ignora mientras el aviso está abierto.
    const onActivity = () => {
      if (!warningRef.current) markActivity();
    };

    // Volver a la pestaña cuenta como actividad, pero antes se salda lo que pasó
    // mientras estuvo oculta: si ya venció, se cierra.
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      tick();
      if (!loggingOut.current) onActivity();
    };

    // Otra pestaña escribió (actividad) o borró (logout) la clave.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== LAST_ACTIVITY_KEY) return;
      if (e.newValue === null) {
        doLogout();
        return;
      }
      const v = parseLastActivity(e.newValue);
      if (v !== null) {
        lastActivity.current = v;
        setRemaining(remainingMs(v, Date.now()));
      }
    };

    const EVENTS: (keyof WindowEventMap)[] = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    EVENTS.forEach((ev) => window.addEventListener(ev, onActivity, { passive: true }));
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('storage', onStorage);
    const id = window.setInterval(tick, 1000);
    return () => {
      EVENTS.forEach((ev) => window.removeEventListener(ev, onActivity));
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('storage', onStorage);
      window.clearInterval(id);
    };
  }, [markActivity, doLogout]);

  const warning = remaining !== null && remaining <= INACTIVITY_WARN_MS;
  warningRef.current = warning;

  return (
    <RestanteContext.Provider value={{ remaining, warning }}>
      {children}
      {warning && remaining !== null && (
        <InactivityModal remaining={remaining} onContinue={() => markActivity(true)} onLogout={doLogout} />
      )}
    </RestanteContext.Provider>
  );
}

/** Contador mm:ss para los headers autenticados. Vacío en el render del servidor. */
export function InactivityCountdown() {
  const { remaining, warning } = useContext(RestanteContext);
  return (
    <span
      data-testid="inactivity-countdown"
      title="Tiempo restante de sesión por inactividad"
      aria-live="off"
      className={`${GeistMono.className} inline-block min-w-[3.25rem] rounded border px-1.5 py-0.5 text-center text-xs font-semibold tabular-nums ${
        warning ? 'border-warn/40 bg-surface text-warn' : 'border-line bg-surface text-[#0b7a6d]'
      }`}
    >
      {remaining === null ? '' : formatMmSs(remaining)}
    </span>
  );
}

/**
 * Sale por portal a document.body: el <aside> del shell usa transform para
 * deslizarse en móvil, y un transform convierte al elemento en containing block
 * de sus descendientes `fixed` — sin portal el overlay quedaría recortado.
 */
function InactivityModal({ remaining, onContinue, onLogout }: { remaining: number; onContinue: () => void; onLogout: () => void }) {
  const continueRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    continueRef.current?.focus();
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[60] grid place-items-center bg-ink/40 px-4" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="inactivity-title"
        aria-describedby="inactivity-desc"
        data-testid="inactivity-modal"
        className="w-full max-w-[400px] rounded-lg border border-line bg-surface p-6 shadow-card-hover"
      >
        <div className="flex items-center gap-2 text-warn">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="shrink-0" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          <h2 id="inactivity-title" className="text-base font-semibold text-ink">
            Su sesión está por cerrarse
          </h2>
        </div>
        <p id="inactivity-desc" className="mt-3 text-sm leading-relaxed text-ink-muted">
          Por seguridad, su sesión se cerrará por inactividad en{' '}
          <span className={`${GeistMono.className} font-semibold tabular-nums text-warn`}>{formatMmSs(remaining)}</span>. ¿Desea
          continuar trabajando?
        </p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onLogout}
            className="rounded border border-line bg-surface px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
          >
            Cerrar sesión
          </button>
          <button
            ref={continueRef}
            type="button"
            onClick={onContinue}
            className="rounded bg-accent px-3 py-2 text-sm font-semibold text-ink-inverse transition-colors hover:bg-accent-dark"
          >
            Continuar
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
