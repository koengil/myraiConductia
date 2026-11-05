'use client';

const buttonClass =
  'rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[4px] text-[length:var(--text-xs)] font-medium disabled:opacity-60';

export function AccessDecideButtons({
  busy,
  onApprove,
  onDeny,
}: {
  busy: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <span className="flex shrink-0 gap-[var(--space-2)]">
      <button
        type="button"
        disabled={busy}
        onClick={onApprove}
        className={`${buttonClass} text-[var(--ink)] hover:border-[var(--accent)] hover:text-[var(--accent)]`}
      >
        Approve
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onDeny}
        className={`${buttonClass} text-[var(--ink-secondary)] hover:text-[var(--ink)]`}
      >
        Deny
      </button>
    </span>
  );
}
