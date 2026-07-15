'use client';

import { ReactNode } from 'react';

/** Título de página en serif + subtítulo secundario. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="font-serif text-3xl sm:text-4xl font-semibold tracking-tight text-ink">
          {title}
        </h1>
        {subtitle && <p className="mt-2 text-sm text-ink-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Heading de sección en serif. */
export function SectionTitle({ children, as: Tag = 'h2' }: { children: ReactNode; as?: 'h2' | 'h3' }) {
  return <Tag className="font-serif text-xl font-semibold tracking-tight text-ink">{children}</Tag>;
}

/** Contenedor blanco con borde sutil, sin sombra fuerte. */
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-line bg-surface ${className}`}>{children}</div>
  );
}

export type Tone = 'neutral' | 'accent' | 'warn' | 'danger';

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-ink',
  accent: 'text-accent',
  warn: 'text-warn',
  danger: 'text-danger',
};

const BADGE_TONE: Record<Tone, string> = {
  neutral: 'bg-cream text-ink-muted border-line-strong',
  accent: 'bg-accent-soft text-accent border-accent/15',
  warn: 'bg-warn-soft text-warn border-warn/15',
  danger: 'bg-danger-soft text-danger border-danger/15',
};

/** KPI: label pequeño, valor grande tabular, delta opcional. */
export function KpiCard({
  label,
  value,
  delta,
  tone = 'neutral',
  hint,
}: {
  label: string;
  value: ReactNode;
  delta?: string;
  tone?: Tone;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface p-6">
      <div className="text-xs font-medium uppercase tracking-wider text-ink-muted">{label}</div>
      <div className={`mt-3 tabular font-serif text-3xl font-semibold ${TONE_TEXT[tone]}`}>
        {value}
      </div>
      {delta && (
        <div className={`mt-2 tabular text-xs font-medium ${TONE_TEXT[tone]}`}>{delta}</div>
      )}
      {hint && <div className="mt-2 text-xs text-ink-faint">{hint}</div>}
    </div>
  );
}

/** Badge de estado. La lógica de qué tono usar vive en cada módulo. */
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: Tone;
}) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${BADGE_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

/** Botón de filtro / segmented control. */
export function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded border px-3 py-1.5 text-sm font-medium transition-colors ${
        active
          ? 'border-accent bg-accent text-ink-inverse'
          : 'border-line bg-surface text-ink-muted hover:bg-surface-hover hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

/** Botón primario. */
export function Button({
  children,
  onClick,
  variant = 'primary',
  type = 'button',
  disabled,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary';
  type?: 'button' | 'submit';
  disabled?: boolean;
  className?: string;
}) {
  const styles =
    variant === 'primary'
      ? 'bg-accent text-ink-inverse border-accent hover:bg-accent-dark'
      : 'bg-surface text-ink border-line hover:bg-surface-hover';
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded border px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

// Clases literales: Tailwind purga las construidas por interpolación.
const ALIGN: Record<'left' | 'center' | 'right', string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

/** Cabecera de tabla sobre crema sutil. */
export function Th({
  children,
  align = 'left',
  className = '',
}: {
  children?: ReactNode;
  align?: 'left' | 'center' | 'right';
  className?: string;
}) {
  return (
    <th
      className={`px-4 py-3 ${ALIGN[align]} text-xs font-semibold uppercase tracking-wider text-ink-muted ${className}`}
    >
      {children}
    </th>
  );
}

/** Estado vacío / de carga / error dentro de una tabla o card. */
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-4 py-12 text-center">
      <div className="font-medium text-ink">{title}</div>
      {hint && <div className="mt-1 text-sm text-ink-muted">{hint}</div>}
    </div>
  );
}
