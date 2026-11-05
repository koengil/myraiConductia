'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Wordmark } from '@/components/brand/Wordmark';

type JoinContext = {
  email: string;
  displayName: string;
  inviterName: string;
  companyName: string;
  dealCodename: string | null;
  companyRole: string | null;
  dealRole: string | null;
};

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; context: JoinContext }
  | { kind: 'mfa' }
  | { kind: 'dead-end'; message: string };

type ErrorPayload = { error?: string; code?: string };

const inputClass =
  'rounded-[var(--radius-input)] border-0 bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] font-sans text-[length:var(--text-sm)] text-[var(--ink)] placeholder:text-[var(--ink-quiet)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]';
const primaryButton =
  'flex min-h-[44px] items-center justify-center rounded-[var(--radius-button)] bg-[var(--ink)] px-[var(--space-4)] py-[var(--space-3)] font-sans text-[length:var(--text-sm)] font-medium text-[var(--accent-contrast)] transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:opacity-50';
const bodyText = 'text-center font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]';
const RESUME_MFA = '/two-factor?redirectTo=%2Fjoin%2Fconfirm';

function humanize(value: string | null): string | null {
  if (!value) return null;
  const words = value.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Map a failed API answer to the next screen state. */
function failurePhase(status: number, payload: ErrorPayload): Phase | null {
  if (payload.code === 'mfa_required' || payload.error === 'mfa_required') return { kind: 'mfa' };
  if (status === 410 || status === 403 || status === 401) {
    return {
      kind: 'dead-end',
      message:
        status === 401
          ? 'Your session ended. Open your invitation email to continue.'
          : (payload.error ?? 'This invitation is no longer open. Ask the sender to resend it.'),
    };
  }
  return null;
}

export default function ConfirmJoinClient() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [displayName, setDisplayName] = useState('');
  const [tosAccepted, setTosAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const res = await fetch('/api/v1/work-identity/context').catch(() => null);
      if (!active) return;
      if (!res) {
        setPhase({ kind: 'dead-end', message: 'Something went wrong. Reload the page to try again.' });
        return;
      }
      const payload = (await res.json().catch(() => ({}))) as JoinContext & ErrorPayload;
      if (!active) return;
      if (!res.ok) {
        setPhase(
          failurePhase(res.status, payload) ?? {
            kind: 'dead-end',
            message: 'Something went wrong. Reload the page to try again.',
          },
        );
        return;
      }
      setDisplayName(payload.displayName);
      setPhase({ kind: 'ready', context: payload });
    })();
    return () => {
      active = false;
    };
  }, []);

  const accept = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setError(null);
      setBusy(true);
      const res = await fetch('/api/v1/work-identity/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName, tosAccepted }),
      }).catch(() => null);
      const payload = (res ? await res.json().catch(() => ({})) : {}) as ErrorPayload & {
        dealId?: string | null;
        dealCode?: string | null;
      };
      if (!res?.ok) {
        setBusy(false);
        const next = res ? failurePhase(res.status, payload) : null;
        if (next) setPhase(next);
        else setError(payload.error ?? 'Something went wrong. Try again.');
        return;
      }
      const dealSegment = payload.dealCode ?? payload.dealId;
      router.replace(dealSegment ? `/projects/${dealSegment}` : '/projects');
      router.refresh();
    },
    [displayName, router, tosAccepted],
  );

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-[var(--surface-warm)] px-[var(--page-pad)] py-[var(--space-12)]">
      <div className="relative z-10 flex w-full max-w-[420px] flex-col gap-[var(--space-6)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-8)]">
        <div className="flex flex-col items-center gap-[var(--space-4)]">
          <Wordmark size={24} tone="on-light" />
          <h1 className="text-center font-sans text-[length:var(--text-md)] font-medium text-[var(--ink)]">
            Confirm your access
          </h1>
        </div>

        {phase.kind === 'loading' ? (
          <p className="text-center font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            Loading your invitation…
          </p>
        ) : null}

        {phase.kind === 'mfa' ? (
          <>
            <p role="status" className={bodyText}>
              Finish two-factor verification to continue.
            </p>
            <a className={primaryButton} href={RESUME_MFA}>
              Continue verification
            </a>
          </>
        ) : null}

        {phase.kind === 'dead-end' ? (
          <p role="status" className={bodyText}>
            {phase.message}
          </p>
        ) : null}

        {phase.kind === 'ready' ? (
          <form onSubmit={accept} className="flex flex-col gap-[var(--space-6)]">
            <p className={bodyText}>
              {phase.context.inviterName} invited you to join {phase.context.companyName}
              {phase.context.dealCodename ? ` on ${phase.context.dealCodename}` : ''}.
            </p>

            <dl className="grid grid-cols-[auto_1fr] gap-x-[var(--space-4)] gap-y-[var(--space-2)] font-sans text-[length:var(--text-sm)]">
              <dt className="text-[var(--ink-secondary)]">Work account</dt>
              <dd className="font-mono text-[var(--ink)]">{phase.context.email}</dd>
              <dt className="text-[var(--ink-secondary)]">Firm</dt>
              <dd className="text-[var(--ink)]">{phase.context.companyName}</dd>
              {phase.context.companyRole ? (
                <>
                  <dt className="text-[var(--ink-secondary)]">Role</dt>
                  <dd className="text-[var(--ink)]">{humanize(phase.context.companyRole)}</dd>
                </>
              ) : null}
              {phase.context.dealCodename ? (
                <>
                  <dt className="text-[var(--ink-secondary)]">Deal</dt>
                  <dd className="text-[var(--ink)]">
                    {phase.context.dealCodename}
                    {phase.context.dealRole ? `, ${humanize(phase.context.dealRole)}` : ''}
                  </dd>
                </>
              ) : null}
            </dl>

            <label className="flex flex-col gap-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)]">
              Display name
              <input
                className={inputClass}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name"
                maxLength={120}
                required
              />
            </label>

            <label className="flex items-start gap-[var(--space-2)] font-sans text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
              <input
                type="checkbox"
                className="mt-[2px] accent-[var(--ink)]"
                checked={tosAccepted}
                onChange={(e) => setTosAccepted(e.target.checked)}
              />
              <span>
                I have read and accept the Conductia{' '}
                <a
                  href="/terms"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[var(--ink)] underline underline-offset-2"
                >
                  Terms of Service
                </a>{' '}
                and{' '}
                <a
                  href="/privacy"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[var(--ink)] underline underline-offset-2"
                >
                  Privacy Policy
                </a>
                .
              </span>
            </label>

            <button
              type="submit"
              disabled={busy || !tosAccepted || !displayName.trim()}
              className={primaryButton}
            >
              {busy ? 'Accepting…' : 'Accept invitation'}
            </button>

            {error ? (
              <p
                role="alert"
                className="font-mono text-[length:var(--text-xs)] text-[var(--status-blocked)]"
              >
                {error}
              </p>
            ) : null}
          </form>
        ) : null}
      </div>
    </main>
  );
}
