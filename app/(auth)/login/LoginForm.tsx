'use client';

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { login, type LoginState } from './actions';

const INICIAL: LoginState = { error: null };

const campo =
  'mt-1.5 block w-full rounded-md border border-[var(--jl-border)] bg-[var(--jl-surface)] px-3 py-2.5 text-sm text-[var(--jl-fg)] placeholder:text-[var(--jl-muted)]';

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
  const [ver, setVer] = useState(false);

  return (
    <form action={action} className="mt-6" noValidate>
      <input type="hidden" name="next" value={next} />

      <label htmlFor="email" className="block text-sm font-medium">
        Correo
      </label>
      <input id="email" name="email" type="email" autoComplete="email" required autoFocus className={campo} placeholder="usted@empresa.com" />

      <label htmlFor="password" className="mt-4 block text-sm font-medium">
        Contraseña
      </label>
      <div className="relative">
        <input
          id="password"
          name="password"
          type={ver ? 'text' : 'password'}
          autoComplete="current-password"
          required
          className={`${campo} pr-20`}
        />
        <button
          type="button"
          onClick={() => setVer((v) => !v)}
          aria-pressed={ver}
          aria-controls="password"
          className="absolute inset-y-0 right-0 mt-1.5 px-3 text-xs font-medium text-[var(--jl-accent-ink)]"
        >
          {ver ? 'Ocultar' : 'Ver'}
        </button>
      </div>

      {state.error && (
        <p role="alert" className="mt-4 rounded-md bg-[var(--jl-danger-soft)] px-3 py-2 text-sm text-[var(--jl-danger)]">
          {state.error}
        </p>
      )}

      <Entrar />
    </form>
  );
}
