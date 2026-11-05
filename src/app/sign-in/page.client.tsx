'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { Wordmark } from '@/components/brand/Wordmark';
import { PasswordField } from '@/components/auth/PasswordField';
import { safeAuthDestination } from '@/lib/auth/redirect';

const subscribeToNothing = () => () => {};

// Provider marks per Google and Microsoft sign-in branding guidelines.
const GoogleMark = () => (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18">
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
    <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
  </svg>
);
const MicrosoftMark = () => (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18">
    <path fill="#F25022" d="M0 0h8.5v8.5H0z" />
    <path fill="#7FBA00" d="M9.5 0H18v8.5H9.5z" />
    <path fill="#00A4EF" d="M0 9.5h8.5V18H0z" />
    <path fill="#FFB900" d="M9.5 9.5H18V18H9.5z" />
  </svg>
);

const WORK_PROVIDERS = [
  { provider: 'google', label: 'Continue with Google Workspace', Mark: GoogleMark },
  { provider: 'azure', label: 'Continue with Microsoft', Mark: MicrosoftMark },
] as const;

type SignInPageProps = {
  /** Server-read `work_identity_onboarding` flag. */
  workIdentityEnabled?: boolean;
  /** Copy for an error code returned by a work-account round trip. */
  workIdentityError?: string | null;
};

export default function SignInPage({
  workIdentityEnabled = false,
  workIdentityError = null,
}: SignInPageProps = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = safeAuthDestination(searchParams.get('redirectTo'));

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(workIdentityError);
  const [busy, setBusy] = useState(false);
  // With work sign-in on, the email fields wait behind "Or sign in with email"
  // and stay open once revealed. With it off they are the whole page.
  const [emailRequested, setEmailRequested] = useState(false);
  const emailOpen = !workIdentityEnabled || emailRequested;
  const emailRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (workIdentityEnabled && emailRequested) emailRef.current?.focus();
  }, [workIdentityEnabled, emailRequested]);
  const ready = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );

  const supabase = useMemo(() => {
    try {
      return createSupabaseBrowserClient();
    } catch {
      return null;
    }
  }, []);

  const signIn = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!supabase) {
        setError('Supabase is not configured (.env.local).');
        return;
      }
      setError(null);
      setBusy(true);
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (signInError) {
        setBusy(false);
        setError(signInError.message);
        return;
      }
      // The server-side middleware owns MFA policy. Established accounts can
      // proceed directly in invite-only development mode; users marked by the
      // invitation pipeline are redirected to two-factor there.
      router.replace(redirectTo);
      router.refresh();
    },
    [email, password, redirectTo, router, supabase],
  );

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-[var(--surface-warm)] px-[var(--page-pad)] py-[var(--space-12)]">
      <form
        onSubmit={signIn}
        className="relative z-10 flex w-full max-w-[420px] flex-col gap-[var(--space-6)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-8)]"
      >
        <div className="flex flex-col items-center gap-[var(--space-4)]">
          <Wordmark size={24} tone="on-light" />
          <p className="text-center font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            Sign in to your deals.
          </p>
        </div>

        {/* Work accounts first, email below (the standard order); flag off shows the email form only. */}
        {workIdentityEnabled ? (
          <div className="flex flex-col gap-[var(--space-3)]">
            {WORK_PROVIDERS.map(({ provider, label, Mark }) => (
              <button
                key={provider}
                type="button"
                onClick={() => {
                  // A route handler that redirects to the provider: full navigation.
                  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                  window.location.href = `/auth/work/signin?${new URLSearchParams({ provider, redirectTo }).toString()}`;
                }}
                className="flex min-h-[44px] items-center justify-center gap-[var(--space-3)] rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-4)] py-[var(--space-3)] font-sans text-[length:var(--text-sm)] font-medium text-[var(--ink)] transition-colors duration-150 hover:border-[var(--ink-tertiary)] hover:bg-[var(--surface-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]"
              >
                <Mark />
                {label}
              </button>
            ))}
            <div className="flex items-center gap-[var(--space-3)]">
              <span aria-hidden="true" className="h-px flex-1 bg-[var(--stroke)]" />
              <button
                type="button"
                aria-expanded={emailOpen}
                aria-controls={emailOpen ? 'email-signin-fields' : undefined}
                onClick={() => setEmailRequested(true)}
                className="rounded-[var(--radius-button)] px-[var(--space-2)] py-[var(--space-1)] font-sans text-[length:var(--text-xs)] text-[var(--ink-secondary)] transition-colors duration-150 hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]"
              >
                Or sign in with email
              </button>
              <span aria-hidden="true" className="h-px flex-1 bg-[var(--stroke)]" />
            </div>
          </div>
        ) : null}

        {emailOpen ? (
          <div id="email-signin-fields" className="flex flex-col gap-[var(--space-6)]">
            <label className="flex flex-col gap-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)]">
              Email
              <input
                ref={emailRef}
                type="email"
                className="rounded-[var(--radius-input)] border-0 bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] font-sans text-[length:var(--text-sm)] text-[var(--ink)] placeholder:text-[var(--ink-quiet)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@yourbank.com"
                autoComplete="username"
                autoFocus={!workIdentityEnabled}
                required
              />
            </label>

            <PasswordField
              label="Password"
              value={password}
              onChange={setPassword}
              placeholder="Your password"
              autoComplete="current-password"
              required
            />

            <button
              type="submit"
              disabled={!ready || busy}
              className="rounded-[var(--radius-button)] bg-[var(--ink)] px-[var(--space-4)] py-[var(--space-3)] font-sans text-[length:var(--text-sm)] font-medium text-[var(--accent-contrast)] transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:opacity-50"
            >
              {ready ? (busy ? 'Signing in…' : 'Sign in') : 'Preparing sign in…'}
            </button>
          </div>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="font-mono text-[length:var(--text-xs)] text-[var(--status-blocked)]"
          >
            {error}
          </p>
        ) : null}
      </form>
    </main>
  );
}
