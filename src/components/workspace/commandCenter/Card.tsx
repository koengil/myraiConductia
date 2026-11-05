import * as React from 'react';

/** Shared control styles for the Conductor Center (Workbench kit §02). */
export const primaryButton =
  'inline-flex h-[30px] shrink-0 items-center justify-center whitespace-nowrap rounded-[var(--radius-control)] bg-[var(--accent)] px-3 text-[length:var(--text-xs)] font-medium text-[var(--accent-contrast)]! transition-colors duration-150 hover:bg-[var(--accent-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 disabled:opacity-60';

export const ghostButton =
  'inline-flex h-[30px] shrink-0 items-center justify-center whitespace-nowrap rounded-[var(--radius-control)] px-3 text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)] transition-colors duration-150 hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-60';

/** "1 item" / "2 items". */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** A Workbench card: hairline border, 46px header with an h2 and quiet meta. */
export function Card({
  title,
  meta,
  children,
  id,
}: {
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
}) {
  const headingId = `${id ?? title.toLowerCase().replace(/\W+/g, '-')}-heading`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className="min-w-0 overflow-hidden rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)]"
    >
      <div className="flex min-h-[46px] flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--stroke)] px-4 py-2.5">
        <h2 id={headingId} className="text-[13.5px] font-semibold text-[var(--ink)]">
          {title}
        </h2>
        {meta ? (
          <div className="ml-auto flex min-w-0 items-center gap-2 text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            {meta}
          </div>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-3.5 text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">{children}</p>;
}
