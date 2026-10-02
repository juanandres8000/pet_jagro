import { JumpLightLogo } from './logo';

/** Barra de producto JumpLight (40 px): wordmark · producto. */
export function JumpLightBar({ producto }: { producto: string }) {
  return (
    <header className="flex h-10 items-center justify-between border-b border-[var(--jl-border)] bg-[var(--jl-surface)] px-4 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <JumpLightLogo className="text-[15px]" />
        <span className="text-[var(--jl-border)]" aria-hidden="true">
          ·
        </span>
        <span className="truncate text-[var(--jl-muted)]">{producto}</span>
      </div>
    </header>
  );
}
