import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { UsuarioProvider } from '@/components/UsuarioContext';
import { InactivityGuard } from '@/components/inactivity-guard';

/**
 * Layout de toda la app autenticada (/ y /pyg). El middleware ya bloquea sin
 * sesión; esto es la segunda barrera y además resuelve el usuario para el shell.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <UsuarioProvider usuario={{ email: user.email ?? '' }}>
      <InactivityGuard>{children}</InactivityGuard>
    </UsuarioProvider>
  );
}
