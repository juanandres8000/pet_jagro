import type { Metadata } from 'next';
import { JumpLightSplit } from '@/components/jumplight/split';
import { LoginForm } from './LoginForm';

export const metadata: Metadata = {
  title: 'Ingresar · Pet Jagro',
};

/** Motivos con los que /auth/callback devuelve al login. */
const AVISOS: Record<string, string> = {
  enlace: 'El enlace no es válido o ya expiró. Solicite uno nuevo a su administrador.',
};

export default function LoginPage({ searchParams }: { searchParams: { next?: string | string[]; error?: string | string[] } }) {
  const next = typeof searchParams.next === 'string' ? searchParams.next : '/';
  const aviso = typeof searchParams.error === 'string' ? AVISOS[searchParams.error] : undefined;

  return (
    <JumpLightSplit
      titulo="Ingresar"
      descripcion="Use el correo y la contraseña de su cuenta."
      pie="¿Olvidó su contraseña? Contacte a su administrador."
    >
      {aviso && (
        <p role="alert" className="mt-4 rounded-md bg-[var(--jl-danger-soft)] px-3 py-2 text-sm text-[var(--jl-danger)]">
          {aviso}
        </p>
      )}
      <LoginForm next={next} />
    </JumpLightSplit>
  );
}
