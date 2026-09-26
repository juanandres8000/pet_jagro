import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';

/**
 * Layout de las pantallas de acceso JumpLight (/login y /auth/definir-contrasena).
 * Geist sólo vive aquí (paquete `geist`: Next 14.2
 * no trae Geist en next/font/google); el resto de la app sigue con
 * Inter/Fraunces del root layout.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <div className={`jl-login ${GeistSans.variable} ${GeistMono.variable}`}>{children}</div>;
}
