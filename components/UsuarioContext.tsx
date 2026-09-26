'use client';

import { createContext, useContext, type ReactNode } from 'react';

/** Usuario autenticado, resuelto en el layout de app/(app) con getUser(). */
export interface Usuario {
  email: string;
}

const UsuarioContext = createContext<Usuario | null>(null);

export function UsuarioProvider({ usuario, children }: { usuario: Usuario; children: ReactNode }) {
  return <UsuarioContext.Provider value={usuario}>{children}</UsuarioContext.Provider>;
}

/** null sólo fuera de app/(app), donde no hay sesión. */
export const useUsuario = () => useContext(UsuarioContext);
