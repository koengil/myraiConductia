'use client';

/**
 * Shown while the Gate 0 lead catalog is prefetching (New mandate entry),
 * and reused for the same in-page wait on other directory surfaces.
 */
export function Gate0LeadLoader({ label = 'Loading leads…' }: { label?: string }) {
  return (
    <div
      className="flex flex-col items-center gap-[var(--space-3)] py-[var(--space-8)]"
      aria-busy="true"
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className="size-6 animate-spin rounded-full border-2 border-[var(--stroke)] border-t-[var(--accent)]"
      />
      <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        {label}
      </p>
    </div>
  );
}
