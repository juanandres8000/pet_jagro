'use client';

import { useEffect, useRef } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { PasswordField } from '@/components/jumplight/password-field';
import { cambiarContrasena, type CambiarState } from './actions';

const INICIAL: CambiarState = { error: null, ok: false };

function Cambiar() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-6 w-full rounded-md bg-[var(--jl-accent)] px-4 py-2.5 text-sm font-semibold text-[#0b0f14] transition hover:brightness-95 disabled:cursor-wait disabled:opacity-70"
    >
      {pending ? 'Guardando…' : 'Cambiar contraseña'}
    </button>
  );
}

export function CambiarForm() {
  const [state, action] = useFormState(cambiarContrasena, INICIAL);
  const form = useRef<HTMLFormElement>(null);

  // Tras el éxito no quedan contraseñas en pantalla.
  useEffect(() => {
    if (state.ok) form.current?.reset();
  }, [state]);

  return (
    <form ref={form} action={action} className="mt-6" noValidate>
      <PasswordField id="actual" label="Contraseña actual" autoComplete="current-password" />
      <PasswordField id="nueva" label="Nueva contraseña" autoComplete="new-password" minLength={10} className="mt-4" />
      <p className="mt-1.5 text-xs text-[var(--jl-muted)]">Mínimo 10 caracteres y distinta de la actual.</p>
      <PasswordField id="confirmar" label="Confirmar nueva contraseña" autoComplete="new-password" minLength={10} className="mt-4" />

      {state.error && (
        <p role="alert" className="mt-4 rounded-md bg-[var(--jl-danger-soft)] px-3 py-2 text-sm text-[var(--jl-danger)]">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="mt-4 rounded-md bg-[var(--jl-success-soft)] px-3 py-2 text-sm text-[var(--jl-success)]">
          Su contraseña se cambió correctamente. Úsela la próxima vez que ingrese.
        </p>
      )}

      <Cambiar />
    </form>
  );
}
