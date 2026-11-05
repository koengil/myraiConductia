'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Wordmark } from '@/components/brand/Wordmark';
import { safeAuthDestination } from '@/lib/auth/redirect';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { clearLocalStores } from '@/lib/session/clearLocalStores';
import { abortAllReads } from '@/lib/api/inflightRead';

type TotpFactor = {
  id: string;
  friendly_name?: string;
};

type Preparation =
  | { kind: 'complete' }
  | { kind: 'challenge'; factors: TotpFactor[] }
  | {
      kind: 'enroll';
      factorId: string;
      qrCode: string;
      secret: string;
    };

type MfaEvent = 'mfa_enrolled' | 'mfa_challenged';

async function prepareMfa(
  supabase: ReturnType<typeof createSupabaseBrowserClient>,
): Promise<Preparation> {
  const { data: assurance, error: assuranceError } =
    await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (assuranceError) throw new Error('assurance_lookup_failed');
  if (assurance.currentLevel === 'aal2') return { kind: 'complete' };

  const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
  if (factorsError) throw new Error('factor_lookup_failed');

  const verifiedTotp = factors.totp.map((factor) => ({
    id: factor.id,
    friendly_name: factor.friendly_name,
  }));
  if (verifiedTotp.length > 0) {
    return { kind: 'challenge', factors: verifiedTotp };
  }

  const staleTotp = factors.all.filter(
    (factor) => factor.factor_type === 'totp' && factor.status === 'unverified',
  );
  for (const factor of staleTotp) {
    const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
    if (error) throw new Error('stale_factor_cleanup_failed');
  }

  const { data: enrollment, error: enrollmentError } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'Conductia authenticator',
  });
  if (enrollmentError) throw new Error('enrollment_failed');

  return {
    kind: 'enroll',
    factorId: enrollment.id,
    qrCode: enrollment.totp.qr_code,
    secret: enrollment.totp.secret,
  };
}

function qrCodeSource(value: string): string {
  return value.startsWith('data:')
    ? value
    : `data:image/svg+xml;utf-8,${encodeURIComponent(value)}`;
}

export default function TwoFactorPageClient({ destination }: { destination: string }) {
  const router = useRouter();
  const safeDestination = safeAuthDestination(destination);
  const preparationRef = useRef<Promise<Preparation> | null>(null);
  const supabase = useMemo(() => {
    try {
      return createSupabaseBrowserClient();
    } catch {
      return null;
    }
  }, []);
  const [preparation, setPreparation] = useState<Preparation | null>(null);
  const [factorId, setFactorId] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(() =>
    supabase
      ? null
      : 'Two-factor authentication is unavailable because authentication is not configured.',
  );
  const [busy, setBusy] = useState(false);
  const [pendingAudit, setPendingAudit] = useState<MfaEvent | null>(null);

  const continueToDestination = useCallback(() => {
    router.replace(safeDestination);
    router.refresh();
  }, [router, safeDestination]);

  useEffect(() => {
    if (!supabase) return;

    preparationRef.current ??= prepareMfa(supabase);
    let active = true;
    void preparationRef.current
      .then((nextPreparation) => {
        if (!active) return;
        if (nextPreparation.kind === 'complete') {
          continueToDestination();
          return;
        }
        setPreparation(nextPreparation);
        if (nextPreparation.kind === 'challenge') {
          setFactorId(nextPreparation.factors[0]?.id ?? '');
        } else {
          setFactorId(nextPreparation.factorId);
        }
      })
      .catch(() => {
        if (active) {
          setError('Two-factor authentication could not be prepared. Try again or sign out.');
        }
      });

    return () => {
      active = false;
    };
  }, [continueToDestination, supabase]);

  const recordCompletion = useCallback(
    async (event: MfaEvent) => {
      const response = await fetch('/api/v1/auth/mfa/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event }),
      });
      if (!response.ok) throw new Error('audit_failed');
      setPendingAudit(null);
      continueToDestination();
    },
    [continueToDestination],
  );

  const verify = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!supabase || !preparation || !factorId || pendingAudit) return;
      if (!/^\d{6}$/.test(code)) {
        setError('Enter the six-digit code from your authenticator app.');
        return;
      }

      setBusy(true);
      setError(null);
      const challenge = await supabase.auth.mfa.challenge({ factorId });
      if (challenge.error) {
        setBusy(false);
        setError('Authenticator verification is unavailable. Try again or sign out.');
        return;
      }

      const verification = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.data.id,
        code,
      });
      if (verification.error) {
        setBusy(false);
        setCode('');
        setError(
          'The authenticator code was not accepted. Enter the current six-digit code and try again.',
        );
        return;
      }

      const { data: assurance, error: assuranceError } =
        await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (assuranceError || assurance.currentLevel !== 'aal2') {
        setBusy(false);
        setError('Two-factor assurance could not be confirmed. Try again or sign out.');
        return;
      }

      const auditEvent: MfaEvent = preparation.kind === 'enroll' ? 'mfa_enrolled' : 'mfa_challenged';
      setPendingAudit(auditEvent);
      try {
        await recordCompletion(auditEvent);
      } catch {
        setBusy(false);
        setError(
          'Two-factor verification succeeded, but the security record could not be saved. Retry the security record or sign out.',
        );
      }
    },
    [code, factorId, pendingAudit, preparation, recordCompletion, supabase],
  );

  const retryAudit = useCallback(async () => {
    if (!pendingAudit) return;
    setBusy(true);
    setError(null);
    try {
      await recordCompletion(pendingAudit);
    } catch {
      setBusy(false);
      setError('The security record could not be saved. Retry the security record or sign out.');
    }
  }, [pendingAudit, recordCompletion]);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    setBusy(true);
    setError(null);
    // No read started as this user may deliver after the sign-out (#162).
    abortAllReads();
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) {
      setBusy(false);
      setError('The session could not be cleared. Try signing out again.');
      return;
    }
    clearLocalStores();
    router.replace('/sign-in');
    router.refresh();
  }, [router, supabase]);

  const loading = !preparation && !error;
  const heading = preparation?.kind === 'enroll' ? 'Set up two-factor authentication' : 'Verify your identity';

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-[var(--surface-warm)] px-[var(--page-pad)] py-[var(--space-12)]">
      <section className="relative z-10 flex w-full max-w-[520px] flex-col gap-[var(--space-6)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-8)]">
        <div className="flex flex-col items-center gap-[var(--space-4)]">
          <Wordmark size={24} tone="on-light" />
          <h1 className="text-center font-sans text-[length:var(--text-xl)] font-semibold text-[var(--ink)]">
            {heading}
          </h1>
          <p className="text-center font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            {preparation?.kind === 'enroll'
              ? 'Add Conductia to an authenticator app, then enter the current code.'
              : 'Enter the current code from your authenticator app to continue.'}
          </p>
        </div>

        {loading ? (
          <p role="status" className="text-center text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            Preparing two-factor authentication.
          </p>
        ) : null}

        {preparation?.kind === 'enroll' ? (
          <div className="flex flex-col items-center gap-[var(--space-4)]">
            {/* Supabase supplies this enrollment QR as an SVG data URI. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={qrCodeSource(preparation.qrCode)}
              alt="QR code for the Conductia authenticator enrollment"
              width={220}
              height={220}
              className="rounded-[var(--radius-input)] border border-[var(--stroke)] bg-white p-[var(--space-2)]"
            />
            <div className="w-full rounded-[var(--radius-input)] border border-[var(--stroke)] bg-[var(--surface-subtle)] p-[var(--space-3)]">
              <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                Manual setup key
              </p>
              <code
                // The one sanctioned data-testid on this surface: the secret
                // renders in a bare <code> with no role and no label, so
                // nothing in the accessibility tree disambiguates it. The E2E
                // invite journey reads it here to compute a real TOTP (D8).
                data-testid="mfa-manual-secret"
                className="mt-[var(--space-1)] block break-all font-mono text-[length:var(--text-sm)] text-[var(--ink)]"
              >
                {preparation.secret}
              </code>
            </div>
          </div>
        ) : null}

        {preparation && preparation.kind !== 'complete' && !pendingAudit ? (
          <form onSubmit={verify} className="flex flex-col gap-[var(--space-4)]">
            {preparation.kind === 'challenge' && preparation.factors.length > 1 ? (
              <label className="flex flex-col gap-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)]">
                Authenticator
                <select
                  value={factorId}
                  onChange={(event) => setFactorId(event.target.value)}
                  disabled={busy}
                  className="rounded-[var(--radius-input)] border-0 bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]"
                >
                  {preparation.factors.map((factor, index) => (
                    <option key={factor.id} value={factor.id}>
                      {factor.friendly_name || `Authenticator ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="flex flex-col gap-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)]">
              Six-digit code
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                minLength={6}
                maxLength={6}
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                disabled={busy}
                required
                autoFocus={preparation.kind === 'challenge'}
                className="rounded-[var(--radius-input)] border-0 bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] font-mono text-[length:var(--text-lg)] tracking-[0.2em] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]"
              />
            </label>

            <button
              type="submit"
              disabled={busy}
              className="rounded-[var(--radius-button)] bg-[var(--ink)] px-[var(--space-4)] py-[var(--space-3)] font-medium text-[var(--accent-contrast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:opacity-50"
            >
              {busy ? 'Verifying.' : 'Verify and continue'}
            </button>
          </form>
        ) : null}

        {pendingAudit ? (
          <button
            type="button"
            onClick={retryAudit}
            disabled={busy}
            className="rounded-[var(--radius-button)] bg-[var(--ink)] px-[var(--space-4)] py-[var(--space-3)] font-medium text-[var(--accent-contrast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:opacity-50"
          >
            {busy ? 'Saving the security record.' : 'Retry the security record'}
          </button>
        ) : null}

        {error ? (
          <p role="alert" className="font-mono text-[length:var(--text-xs)] text-[var(--status-blocked)]">
            {error}
          </p>
        ) : null}

        <button
          type="button"
          onClick={signOut}
          disabled={busy}
          className="text-[length:var(--text-sm)] text-[var(--ink-secondary)] underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)] disabled:opacity-50"
        >
          Sign out
        </button>
      </section>
    </main>
  );
}
