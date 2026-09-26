import type { ReactNode } from 'react';
import { JumpLightBar } from './bar';
import { JumpLightLogo } from './logo';

const CONFIANZA = [
  {
    titulo: 'Datos del ERP en tiempo real',
    texto: 'Ventas, cartera y P&G leídos de HGINet a lo largo del día.',
    icono: (
      <path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    ),
  },
  {
    titulo: 'Acceso solo para el equipo autorizado',
    texto: 'Las cuentas las crea su administrador; no hay registro abierto.',
    icono: <path d="M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z" />,
  },
  {
    titulo: 'Cierre automático por inactividad',
    texto: 'Su sesión se cierra sola tras 30 minutos sin actividad.',
    icono: <path d="M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />,
  },
];

/**
 * Pantalla de acceso JumpLight: barra de producto, panel de marca oscuro con las
 * garantías (banda superior en < md) y una card a la derecha. La comparten
 * /login y /auth/definir-contrasena. Va dentro de app/(auth)/layout.tsx, que
 * pone el scope .jl-login y Geist.
 */
export function JumpLightSplit({
  titulo,
  descripcion,
  children,
  pie,
}: {
  titulo: string;
  descripcion: string;
  children: ReactNode;
  pie?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <JumpLightBar producto="Pet Jagro" />

      <div className="flex flex-1 flex-col md:grid md:grid-cols-[5fr_7fr]">
        {/* Panel de marca: columna izquierda en md+, banda superior en móvil. */}
        <section className="flex flex-col justify-between gap-8 bg-[var(--jl-panel-bg)] px-6 py-8 text-[var(--jl-panel-fg)] md:px-12 md:py-14">
          <div>
            <JumpLightLogo className="text-2xl" />
            <h1 className="mt-6 text-3xl font-semibold tracking-tight md:mt-16 md:text-5xl">Pet Jagro</h1>
            <p className="mt-3 max-w-sm text-sm text-[var(--jl-panel-muted)] md:text-base">
              Tablero de gestión comercial y financiera de J Agro.
            </p>
          </div>

          <ul className="hidden space-y-6 md:block">
            {CONFIANZA.map((c) => (
              <li key={c.titulo} className="flex gap-4">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--jl-panel-border)] text-[var(--jl-accent)]">
                  <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {c.icono}
                  </svg>
                </span>
                <div>
                  <p className="text-sm font-medium">{c.titulo}</p>
                  <p className="mt-0.5 text-sm text-[var(--jl-panel-muted)]">{c.texto}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <main className="flex flex-1 items-start justify-center px-4 py-8 md:items-center md:px-12 md:py-10">
          <div className="w-full max-w-sm">
            <p className="jl-mono text-xs uppercase tracking-wider text-[var(--jl-muted)]">Pet Jagro · Sistema de gestión</p>
            <div className="mt-3 rounded-lg border border-[var(--jl-border)] bg-[var(--jl-surface)] p-6 shadow-sm sm:p-8">
              <h2 className="text-xl font-semibold tracking-tight">{titulo}</h2>
              <p className="mt-1 text-sm text-[var(--jl-muted)]">{descripcion}</p>
              {children}
            </div>
            {pie && <p className="mt-4 text-center text-sm text-[var(--jl-muted)]">{pie}</p>}
          </div>
        </main>
      </div>
    </div>
  );
}
