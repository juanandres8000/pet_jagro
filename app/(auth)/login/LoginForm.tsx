'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { JL_CAMPO, PasswordField } from '@/components/jumplight/password-field';
import { login, type LoginState } from './actions';

const INICIAL: LoginState = { error: null };

function Entrar() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-6 w-full rounded-md bg-[var(--jl-accent)] px-4 py-2.5 text-sm font-semibold text-[#0b0f14] transition hover:brightness-95 disabled:cursor-wait disabled:opacity-70"
    >
      {pending ? 'Entrando…' : 'Entrar'}
    </button>
  );
}

export function LoginForm({ next }: { next: string }) {
  const [state, action] = useFormState(login, INICIAL);

  return (
    <form action={action} className="mt-6" noValidate>
      <input type="hidden" name="next" value={next} />

      <label htmlFor="email" className="block text-sm font-medium">
        Correo
      </label>
      <input id="email" name="email" type="email" autoComplete="email" required autoFocus className={JL_CAMPO} placeholder="usted@empresa.com" />

      <PasswordField id="password" label="Contraseña" autoComplete="current-password" className="mt-4" />

      {state.error && (
        <p role="alert" className="mt-4 rounded-md bg-[var(--jl-danger-soft)] px-3 py-2 text-sm text-[var(--jl-danger)]">
          {state.error}
        </p>
      )}

      <Entrar />
    </form>
  );
}
