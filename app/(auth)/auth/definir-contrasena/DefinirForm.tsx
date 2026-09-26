'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { PasswordField } from '@/components/jumplight/password-field';
import { definirContrasena, type DefinirState } from './actions';

const INICIAL: DefinirState = { error: null };

function Guardar() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-6 w-full rounded-md bg-[var(--jl-accent)] px-4 py-2.5 text-sm font-semibold text-[#0b0f14] transition hover:brightness-95 disabled:cursor-wait disabled:opacity-70"
    >
      {pending ? 'Guardando…' : 'Guardar'}
    </button>
  );
}

export function DefinirForm() {
  const [state, action] = useFormState(definirContrasena, INICIAL);

  return (
    <form action={action} className="mt-6" noValidate>
      <PasswordField id="password" label="Nueva contraseña" autoComplete="new-password" minLength={8} />
      <p className="mt-1.5 text-xs text-[var(--jl-muted)]">Mínimo 8 caracteres.</p>
      <PasswordField id="confirmar" label="Confirmar contraseña" autoComplete="new-password" minLength={8} className="mt-4" />

      {state.error && (
        <p role="alert" className="mt-4 rounded-md bg-[var(--jl-danger-soft)] px-3 py-2 text-sm text-[var(--jl-danger)]">
          {state.error}
        </p>
      )}

      <Guardar />
    </form>
  );
}
