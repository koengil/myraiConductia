'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { Wordmark } from '@/components/brand/Wordmark';
import type { WorkIdentityRecovery } from '@/lib/auth/workIdentity';
import { WORK_CONNECT_LABEL, workConnectHref } from '@/lib/auth/workConnect';
import { WORK_IDENTITY_PROVIDERS } from '@/lib/constants/workIdentity';

const PROVIDER_LABEL = {
  google: 'Continue with Google Workspace',
  azure: 'Continue with Microsoft',
} as const;

const STORAGE_KEY = 'conductia.join.invitation';

const primaryAction =
  'flex min-h-[44px] items-center justify-center rounded-[var(--radius-button)] bg-[var(--ink)] px-[var(--space-4)] py-[var(--space-3)] font-sans text-[length:var(--text-sm)] font-medium text-[var(--accent-contrast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]';
const secondaryAction =
  'flex min-h-[44px] items-center justify-center rounded-[var(--radius-button)] border border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-4)] py-[var(--space-3)] font-sans text-[length:var(--text-sm)] font-medium text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]';
const bodyText = 'text-center font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]';

type JoinPageClientProps = {
  invite: string | null;
  nonce: string | null;
  error: { message: string; recovery: WorkIdentityRecovery } | null;
  step: 'connect' | null;
  connected: boolean;
  /** The invited firm's work-account provider, when the invitation resolves. */
  provider: 'google' | 'azure' | null;
};

type Invitation = { invite: string; nonce: string };

const subscribeToNothing = () => () => {};

function readStoredInvitation(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * The invitation link's id and nonce, from the URL or, after a provider round
 * trip that came back without them, from this tab's session storage so the
 * retry and connect actions can restart the same invitation.
 */
function useInvitation(invite: string | null, nonce: string | null): Invitation | null {
  const stored = useSyncExternalStore(subscribeToNothing, readStoredInvitation, () => null);
  useEffect(() => {
    if (!invite || !nonce) return;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ invite, nonce }));
    } catch {
      // Storage unavailable: retry falls back to the invitation email.
    }
  }, [invite, nonce]);
  if (invite && nonce) return { invite, nonce };
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as Partial<Invitation>;
    return parsed.invite && parsed.nonce ? { invite: parsed.invite, nonce: parsed.nonce } : null;
  } catch {
    return null;
  }
}

export default function JoinPageClient({ invite, nonce, error, step, connected, provider }: JoinPageClientProps) {
  const invitation = useInvitation(invite, nonce);
  const query = invitation
    ? new URLSearchParams({ invite: invitation.invite, k: invitation.nonce }).toString()
    : null;
  const startHref = query ? `/auth/work/start?${query}` : null;
  const joinHref = query ? `/join?${query}` : null;

  let body: React.ReactNode;
  if (error) {
    body = (
      <>
        <p role="alert" className={bodyText}>
          {error.message}
        </p>
        <RecoveryAction recovery={error.recovery} startHref={startHref} joinHref={joinHref} />
      </>
    );
  } else if (step === 'connect' && joinHref) {
    body = (
      <>
        <p className={bodyText}>
          Connect your firm work account to your existing Conductia account, then accept the invitation.
        </p>
        {/* Only the firm's provider can connect; both when the invitation did not say. */}
        {(provider ? [provider] : WORK_IDENTITY_PROVIDERS).map((p) => [p, WORK_CONNECT_LABEL[p]] as const).map(([p, label]) => (
          <Go key={p} className={secondaryAction} href={workConnectHref(p, joinHref)}>
            {label}
          </Go>
        ))}
      </>
    );
  } else if (startHref) {
    body = (
      <>
        <p className={bodyText}>
          {connected
            ? 'Your work account is connected. Continue to accept the invitation.'
            : 'Your firm signs you in with its work account. There is no password to create.'}
        </p>
        <Go className={primaryAction} href={startHref}>
          {provider ? PROVIDER_LABEL[provider] : 'Continue with your work account'}
        </Go>
      </>
    );
  } else {
    body = (
      <p role="status" className={bodyText}>
        Open your invitation email to continue.
      </p>
    );
  }

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-[var(--surface-warm)] px-[var(--page-pad)] py-[var(--space-12)]">
      <section className="relative z-10 flex w-full max-w-[420px] flex-col gap-[var(--space-6)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-8)]">
        <div className="flex flex-col items-center gap-[var(--space-4)]">
          <Wordmark size={24} tone="on-light" />
          <h1 className="text-center font-sans text-[length:var(--text-md)] font-medium text-[var(--ink)]">
            Accept your invitation
          </h1>
        </div>
        {body}
      </section>
    </main>
  );
}

function RecoveryAction({
  recovery,
  startHref,
  joinHref,
}: {
  recovery: WorkIdentityRecovery;
  startHref: string | null;
  joinHref: string | null;
}) {
  if ((recovery === 'switch_account' || recovery === 'retry') && startHref) {
    return (
      <Go className={primaryAction} href={startHref}>
        {recovery === 'switch_account' ? 'Use a different account' : 'Try again'}
      </Go>
    );
  }
  if (recovery === 'sign_in_then_connect' && joinHref) {
    const connectStep = `${joinHref}&step=connect`;
    return (
      <Go className={primaryAction} href={`/sign-in?${new URLSearchParams({ redirectTo: connectStep }).toString()}`}>
        Sign in to your account
      </Go>
    );
  }
  if (recovery === 'connect' && joinHref) {
    return (
      <Go className={primaryAction} href={`${joinHref}&step=connect`}>
        Connect again
      </Go>
    );
  }
  if (recovery === 'resume_mfa') {
    return (
      <Go className={primaryAction} href="/two-factor?redirectTo=%2Fjoin%2Fconfirm">
        Continue verification
      </Go>
    );
  }
  return null;
}

/** Full-page navigation to a server route (OAuth start, sign-in, MFA). */
function Go({ href, className, children }: { href: string; className: string; children: React.ReactNode }) {
  return (
    <button type="button" className={className} onClick={() => window.location.assign(href)}>
      {children}
    </button>
  );
}
