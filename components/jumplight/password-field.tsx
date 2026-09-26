'use client';

import { useState } from 'react';

/** Clases del input de las pantallas JumpLight (tokens de .jl-login). */
export const JL_CAMPO =
  'mt-1.5 block w-full rounded-md border border-[var(--jl-border)] bg-[var(--jl-surface)] px-3 py-2.5 text-sm text-[var(--jl-fg)] placeholder:text-[var(--jl-muted)]';

/** Contraseña con botón Ver/Ocultar. */
export function PasswordField({
  id,
  label,
  autoComplete,
  minLength,
  className = '',
}: {
  id: string;
  label: string;
  autoComplete: 'current-password' | 'new-password';
  minLength?: number;
  className?: string;
}) {
  const [ver, setVer] = useState(false);
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          name={id}
          type={ver ? 'text' : 'password'}
          autoComplete={autoComplete}
          minLength={minLength}
          required
          className={`${JL_CAMPO} pr-20`}
        />
        <button
          type="button"
          onClick={() => setVer((v) => !v)}
          aria-pressed={ver}
          aria-controls={id}
          aria-label={ver ? `Ocultar ${label.toLowerCase()}` : `Ver ${label.toLowerCase()}`}
          className="absolute inset-y-0 right-0 mt-1.5 px-3 text-xs font-medium text-[var(--jl-accent-ink)]"
        >
          {ver ? 'Ocultar' : 'Ver'}
        </button>
      </div>
    </div>
  );
}
