import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';

/**
 * Pantallas de cuenta (/cuenta/*) con el mismo look JumpLight que el login:
 * scope .jl-login + Geist, igual que app/(auth)/layout.tsx. Viven en (app), no
 * en (auth), para heredar la sesión obligatoria y el cierre por inactividad.
 */
export default function CuentaLayout({ children }: { children: React.ReactNode }) {
  return <div className={`jl-login ${GeistSans.variable} ${GeistMono.variable}`}>{children}</div>;
}
