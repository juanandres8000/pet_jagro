import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { JumpLightSplit } from '@/components/jumplight/split';
import { CambiarForm } from './CambiarForm';

export const metadata: Metadata = {
  title: 'Cambiar contraseña · Pet Jagro',
};

/** Cambio de contraseña del usuario con sesión. El middleware y app/(app)/layout ya exigen sesión. */
export default async function CambiarContrasenaPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <JumpLightSplit
      titulo="Cambiar contraseña"
      descripcion={`Confirme su contraseña actual de ${user.email ?? 'su cuenta'} y elija una nueva.`}
      pie={
        <Link href="/" className="font-medium text-[var(--jl-accent-ink)] underline-offset-2 hover:underline">
          ← Volver al tablero
        </Link>
      }
    >
      <CambiarForm />
    </JumpLightSplit>
  );
}
