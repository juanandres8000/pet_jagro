/** Wordmark JumpLight: "Jump" en currentColor y "Light" en el acento. */
export function JumpLightLogo({ className = '' }: { className?: string }) {
  return (
    <span className={`font-semibold tracking-[-0.5px] ${className}`} aria-label="JumpLight">
      <span aria-hidden="true">Jump</span>
      <span aria-hidden="true" style={{ color: 'var(--jl-accent, #2dd4bf)' }}>
        Light
      </span>
    </span>
  );
}
