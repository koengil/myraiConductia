import * as React from 'react';

export interface AvatarInitialsProps {
  initials: string;
  tone?: 'on-light' | 'on-dark';
  className?: string;
}

export function AvatarInitials({
  initials,
  tone = 'on-light',
  className,
}: AvatarInitialsProps) {
  const onDark = tone === 'on-dark';

  return (
    <span
      aria-hidden="true"
      className={[
        'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
        'font-mono text-[length:var(--text-xs)] font-medium',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        background: onDark ? 'var(--shell-active-bg)' : 'var(--surface)',
        color: onDark ? 'var(--shell-ink)' : 'var(--ink)',
        boxShadow: onDark
          ? 'inset 0 0 0 1px var(--shell-panel-border)'
          : 'inset 0 0 0 1px var(--stroke)',
      }}
    >
      {initials}
    </span>
  );
}

export default AvatarInitials;
