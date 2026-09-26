import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { JumpLightSplit } from '@/components/jumplight/split';
import { DefinirForm } from './DefinirForm';

export const metadata: Metadata = {
  title: 'Defina su contraseña · Pet Jagro',
};

/**
 * Destino de /auth/callback para invitaciones y recuperaciones: el enlace del
 * correo ya abrió sesión, falta la contraseña. Requiere sesión; sin ella → /login.
 */
export default async function DefinirContrasenaPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <JumpLightSplit
      titulo="Defina su contraseña"
      descripcion={`Para terminar de activar su cuenta ${user.email ?? ''}, elija la contraseña con la que ingresará.`}
      pie="¿Problemas con el enlace? Contacte a su administrador."
    >
      <DefinirForm />
    </JumpLightSplit>
  );
}
