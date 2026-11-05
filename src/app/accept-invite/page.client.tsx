'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { Wordmark } from '@/components/brand/Wordmark';
import { PASSWORD_HINT, passwordStrength } from '@/lib/auth/passwordStrength';
import { PasswordField } from '@/components/auth/PasswordField';

/** Meter tints follow the compliance verdict palette: blocked / hold / clear. */
const STRENGTH_COLORS: Record<number, string> = {
  0: 'var(--negative)',
  1: 'var(--negative)',
  2: 'var(--hold)',
  3: 'var(--positive)',
};

type Phase = 'checking' | 'verify' | 'verifying' | 'ready' | 'submitting' | 'dead-end';

type InviteContext = {
  status: string;
  email: string;
  verificationRequired: boolean;
  locked: boolean;
  inviterName?: string;
  companyName?: string;
  dealCodename?: string | null;
  companyRole?: string;
  dealRole?: string | null;
};

const CLOSED_STATUS_MESSAGES: Record<string, string> = {
  revoked: 'This invitation was revoked. Ask the person who invited you if that was a mistake.',
  expired: 'This invitation expired. Ask the person who invited you to resend it.',
  accepted: 'This invitation was already used. Sign in instead.',
};

const INVITE_CONTEXT_MISSING = 'invite_context_missing';
const RESEND_NEEDED = 'This invitation needs to be resent. Ask the sender to resend it.';
const PASSWORD_MISMATCH = 'Both passwords must match.';

const inputClass =
  'rounded-[var(--radius-input)] border-0 bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] font-sans text-[length:var(--text-sm)] text-[var(--ink)] placeholder:text-[var(--ink-quiet)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]';

/**
 * Invite acceptance. The emailed link authenticates the invitee through
 * Supabase and lands here; we collect display name + password, then finalize
 * through POST /api/v1/invites/accept (the one endpoint open to 'invited'
 * accounts). Expired or superseded links get an honest dead-end.
 */
export default function AcceptInvitePage() {
  const router = useRouter();

  const supabase = useMemo(() => {
    try {
      return createSupabaseBrowserClient();
    } catch {
      return null;
    }
  }, []);

  const [phase, setPhase] = useState<Phase>(supabase ? 'checking' : 'dead-end');
  const [email, setEmail] = useState<string | null>(null);
  const [context, setContext] = useState<InviteContext | null>(null);
  const [verificationCode, setVerificationCode] = useState('');
  const [attemptsRemaining, setAttemptsRemaining] = useState<number | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [tosAccepted, setTosAccepted] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const strength = passwordStrength(password);
  const passwordsMismatch = confirmPassword.length > 0 && confirmPassword !== password;
  const [deadEndMessage, setDeadEndMessage] = useState<string | null>(
    supabase ? null : 'Supabase is not configured (.env.local).',
  );

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    (async () => {
      // generateLink invite/magiclink emails deliver implicit-grant tokens in
      // the URL hash, but the @supabase/ssr browser client runs the PKCE flow
      // and only consumes ?code= params — so the hash must be exchanged
      // explicitly or the link reads as dead.
      const hash = new URLSearchParams(window.location.hash.slice(1));
      const accessToken = hash.get('access_token');
      const refreshToken = hash.get('refresh_token');
      if (accessToken && refreshToken) {
        // A failed exchange (returned error or throw) dead-ends WITHOUT
        // stripping the hash: the tokens are the only retry state, so a
        // reload can attempt the exchange again (review 6bdabd9 finding 2).
        let exchangeFailed = false;
        try {
          const { error: exchangeError } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          exchangeFailed = Boolean(exchangeError);
        } catch {
          exchangeFailed = true;
        }
        if (cancelled) return;
        if (exchangeFailed) {
          setDeadEndMessage(
            'This link could not sign you in. Reload to try again, or ask the person who invited you to resend it.',
          );
          setPhase('dead-end');
          return;
        }
        // Tokens are credentials; keep them out of history and copied URLs.
        window.history.replaceState(null, '', window.location.pathname);
      }
      // Poll briefly so a slow exchange does not read as a dead link.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (cancelled) return;
        if (user) {
          const metadata = (user.user_metadata ?? {}) as {
            invite_id?: string;
            credential_nonce?: string;
          };
          if (!metadata.invite_id || !metadata.credential_nonce) {
            // The invite keys are gone (for example a provider sign-in
            // replaced them); only a resend rewrites them (plan 1e).
            setDeadEndMessage(RESEND_NEEDED);
            setPhase('dead-end');
            return;
          }
          setEmail(user.email ?? null);
          // Who invited you, into which company, onto which deal (spec-v3
          // criterion 3). A closed invite dead-ends here, before the form;
          // a failed context read degrades to the bare form — the accept
          // endpoint stays the authoritative gate either way.
          try {
            const res = await fetch('/api/v1/invites/context');
            if (cancelled) return;
            if (!res.ok) {
              const failure = (await res.json().catch(() => ({}))) as { code?: string };
              if (cancelled) return;
              if (failure.code === INVITE_CONTEXT_MISSING) {
                setDeadEndMessage(RESEND_NEEDED);
                setPhase('dead-end');
                return;
              }
              // No trusted context, no acceptance form (cr-prr-124-r2 1.1):
              // the context endpoint binds the invite to the authenticated
              // identity, so a failure here means the invitation cannot be
              // verified for this account.
              setDeadEndMessage(
                'This invitation could not be verified for your account. Ask the person who invited you to resend it.',
              );
              setPhase('dead-end');
              return;
            }
            const ctx = (await res.json()) as InviteContext;
            if (cancelled) return;
            const closedMessage = CLOSED_STATUS_MESSAGES[ctx.status];
            if (closedMessage) {
              setDeadEndMessage(closedMessage);
              setPhase('dead-end');
              return;
            }
            setContext(ctx);
            if (ctx.verificationRequired) {
              if (ctx.locked) {
                setDeadEndMessage(
                  'This verification code is locked. Ask the person who invited you to resend the invitation.',
                );
                setPhase('dead-end');
                return;
              }
              setPhase('verify');
              return;
            }
          } catch {
            if (cancelled) return;
            setDeadEndMessage(
              'This invitation could not be verified for your account. Try again in a moment, or ask the person who invited you to resend it.',
            );
            setPhase('dead-end');
            return;
          }
          setPhase('ready');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!cancelled) {
        setDeadEndMessage(
          'This link could not sign you in. It may have expired. Ask the person who invited you to resend it.',
        );
        setPhase('dead-end');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const verify = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!/^\d{6}$/.test(verificationCode)) {
        setError('Enter the six-digit verification code.');
        return;
      }
      setError(null);
      setPhase('verifying');
      try {
        const res = await fetch('/api/v1/invites/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: verificationCode }),
        });
        const outcome = (await res.json().catch(() => ({}))) as {
          code?: string;
          verified?: boolean;
          attemptsRemaining?: number;
          locked?: boolean;
        };
        if (outcome.code === INVITE_CONTEXT_MISSING) {
          setDeadEndMessage(RESEND_NEEDED);
          setPhase('dead-end');
          return;
        }
        if (!res.ok || !outcome.verified) {
          setAttemptsRemaining(outcome.attemptsRemaining ?? null);
          if (outcome.locked) {
            setDeadEndMessage(
              'This verification code is locked. Ask the person who invited you to resend the invitation.',
            );
            setPhase('dead-end');
            return;
          }
          if (outcome.attemptsRemaining === 0) {
            setDeadEndMessage(
              'This invitation cannot be verified. Ask the person who invited you to resend it.',
            );
            setPhase('dead-end');
            return;
          }
          setError('That verification code is not valid.');
          setPhase('verify');
          return;
        }

        const contextRes = await fetch('/api/v1/invites/context');
        const verifiedContext = (await contextRes.json().catch(() => ({}))) as InviteContext;
        if (!contextRes.ok || verifiedContext.verificationRequired) {
          setError('The invitation context could not be verified. Try again.');
          setPhase('verify');
          return;
        }
        setContext(verifiedContext);
        setPhase('ready');
      } catch {
        setError('The verification request failed. Try again.');
        setPhase('verify');
      }
    },
    [verificationCode],
  );

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!supabase) return;
      if (password !== confirmPassword) {
        setError(PASSWORD_MISMATCH);
        return;
      }
      setError(null);
      setPhase('submitting');

      // The password is set by the acceptance transaction itself, bound to
      // this verified session; it is never written to the account beforehand.
      const res = await fetch('/api/v1/invites/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName, tosAccepted, password }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        code?: string;
        error?: string;
        dealId?: string | null;
        dealCode?: string | null;
      };
      if (!res.ok) {
        if (payload.code === INVITE_CONTEXT_MISSING) {
          setDeadEndMessage(RESEND_NEEDED);
          setPhase('dead-end');
          return;
        }
        if (res.status === 410) {
          setDeadEndMessage(
            payload.error ??
              'This invitation is no longer open. Ask the person who invited you to resend it.',
          );
          setPhase('dead-end');
          return;
        }
        setError(payload.error ?? 'Something went wrong. Try again.');
        setPhase('ready');
        return;
      }

      // Project URLs use the human-readable deal code; the UUID is a fallback
      // for the resolver-aware routes.
      const dealSegment = payload.dealCode ?? payload.dealId;
      const destination = dealSegment ? `/projects/${dealSegment}` : '/projects';
      // Invite-created accounts always visit this server-owned policy gate.
      // It renders enrollment/challenge when required and redirects otherwise.
      router.replace(`/two-factor?redirectTo=${encodeURIComponent(destination)}`);
      router.refresh();
    },
    [displayName, password, confirmPassword, tosAccepted, router, supabase],
  );

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-[var(--surface-warm)] px-[var(--page-pad)] py-[var(--space-12)]">
      <div className="relative z-10 flex w-full max-w-[420px] flex-col gap-[var(--space-6)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-8)]">
        <div className="flex flex-col items-center gap-[var(--space-4)]">
          <Wordmark size={24} tone="on-light" />
          <p className="text-center font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            {phase === 'dead-end'
              ? 'This invitation cannot be completed.'
              : phase === 'verify' || phase === 'verifying'
                ? 'Verify this account action.'
                : 'Finish setting up your account.'}
          </p>
        </div>

        {phase === 'checking' ? (
          <p className="text-center font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            Verifying your invitation…
          </p>
        ) : null}

        {phase === 'dead-end' ? (
          <p
            role="status"
            className="text-center font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
          >
            {deadEndMessage}
          </p>
        ) : null}

        {phase === 'verify' || phase === 'verifying' ? (
          <form onSubmit={verify} className="flex flex-col gap-[var(--space-5)]">
            <div className="flex flex-col gap-[var(--space-2)] text-center">
              <p className="font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                Enter the six-digit code sent in a separate email to this address.
              </p>
              <p className="font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                {context?.email ?? email}
              </p>
            </div>
            <label className="flex flex-col gap-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)]">
              Verification code
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                className={inputClass}
                value={verificationCode}
                onChange={(event) =>
                  setVerificationCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                }
                autoFocus
                required
              />
            </label>
            <button
              type="submit"
              disabled={phase === 'verifying'}
              className="rounded-[var(--radius-button)] bg-[var(--ink)] px-[var(--space-4)] py-[var(--space-3)] font-sans text-[length:var(--text-sm)] font-medium text-[var(--accent-contrast)] transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:opacity-50"
            >
              {phase === 'verifying' ? 'Verifying…' : 'Verify code'}
            </button>
            {error ? (
              <p role="status" className="font-mono text-[length:var(--text-xs)] text-[var(--status-blocked)]">
                {error}
                {attemptsRemaining !== null ? ` ${attemptsRemaining} attempts remaining.` : ''}
              </p>
            ) : null}
          </form>
        ) : null}

        {phase === 'ready' || phase === 'submitting' ? (
          <form onSubmit={submit} className="flex flex-col gap-[var(--space-6)]">
            {context?.inviterName && context.companyName ? (
              <p className="text-center font-sans text-[length:var(--text-sm)] text-[var(--ink)]">
                {context.inviterName} invited you to join {context.companyName}
                {context.dealCodename ? ` on ${context.dealCodename}` : ''}.
              </p>
            ) : null}
            {email ? (
              <p className="text-center font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                {email}
              </p>
            ) : null}
            <label className="flex flex-col gap-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)]">
              Your name
              <input
                type="text"
                className={inputClass}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="How your team sees you"
                autoComplete="name"
                autoFocus
                required
              />
            </label>
            <PasswordField
              label="Password"
              value={password}
              onChange={setPassword}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              minLength={8}
              required
            >
              <span className="font-mono text-[length:var(--text-xxs)] text-[var(--ink-tertiary)]">
                {PASSWORD_HINT}
              </span>
              {password ? (
                <span
                  role="status"
                  aria-live="polite"
                  className="flex items-center gap-[var(--space-2)]"
                >
                  <span aria-hidden className="flex items-center gap-[3px]">
                    {[1, 2, 3].map((segment) => (
                      <span
                        key={segment}
                        className="h-[3px] w-[22px] rounded-full"
                        style={{
                          background:
                            segment <= strength.score
                              ? STRENGTH_COLORS[strength.score]
                              : 'var(--stroke-strong)',
                        }}
                      />
                    ))}
                  </span>
                  <span
                    className="font-mono text-[length:var(--text-xxs)]"
                    style={{ color: STRENGTH_COLORS[strength.score] }}
                  >
                    {strength.label}
                  </span>
                </span>
              ) : null}
            </PasswordField>
            <PasswordField
              label="Confirm password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              placeholder="Type it again"
              autoComplete="new-password"
              minLength={8}
              required
              invalid={passwordsMismatch}
              describedById={passwordsMismatch ? 'confirm-password-error' : undefined}
            >
              {passwordsMismatch ? (
                <span
                  id="confirm-password-error"
                  role="status"
                  aria-live="polite"
                  className="font-mono text-[length:var(--text-xxs)] text-[var(--status-blocked)]"
                >
                  {PASSWORD_MISMATCH}
                </span>
              ) : null}
            </PasswordField>
            <label className="flex items-start gap-[var(--space-2)] font-sans text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
              <input
                type="checkbox"
                checked={tosAccepted}
                onChange={(event) => setTosAccepted(event.target.checked)}
                required
                className="mt-[2px] accent-[var(--ink)]"
              />
              <span>
                I have read and accept the Conductia{' '}
                <a
                  href="/terms"
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2 text-[var(--ink)]"
                >
                  Terms of Service
                </a>{' '}
                and{' '}
                <a
                  href="/privacy"
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2 text-[var(--ink)]"
                >
                  Privacy Policy
                </a>
                .
              </span>
            </label>
            <button
              type="submit"
              disabled={phase === 'submitting' || !tosAccepted || passwordsMismatch}
              className="rounded-[var(--radius-button)] bg-[var(--ink)] px-[var(--space-4)] py-[var(--space-3)] font-sans text-[length:var(--text-sm)] font-medium text-[var(--accent-contrast)] transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:opacity-50"
            >
              {phase === 'submitting' ? 'Accepting…' : 'Accept invitation'}
            </button>
            {error ? (
              <p role="status" className="font-mono text-[length:var(--text-xs)] text-[var(--status-blocked)]">
                {error}
              </p>
            ) : null}
          </form>
        ) : null}
      </div>
    </main>
  );
}
