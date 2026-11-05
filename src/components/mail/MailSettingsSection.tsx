'use client';

import * as React from 'react';

import { Button, Card } from '@/components/atoms';
import { PreviewChip } from '@/components/overlay';
import { useFlag } from '@/lib/flags/FlagsContext';
import { ComplianceSettingsCard } from './ComplianceSettingsCard';
import { MailboxConsentCard } from './MailboxConsentCard';
import { MailboxSendingCard } from './MailboxSendingCard';
import { TRY_AGAIN_COPY } from '@/components/deals/DealsUnavailable';

const TEXT = 'font-sans text-[length:var(--text-sm)] leading-relaxed';

const SIGNATURE_SOURCE = { gmail: 'Gmail', outlook: 'Outlook' } as const;
type SignatureSource = keyof typeof SIGNATURE_SOURCE;

/**
 * Signature import, an honest Preview. Reading a signature needs permission
 * to read the mailbox's settings; Conductia asks Google for send only
 * (gmail.send, ADR-0025) and Microsoft for Mail.Send only, so nothing can be
 * imported yet. The buttons read nothing and store nothing, and there is no
 * signature editor on purpose: the signature stays in the banker's own mail
 * client. Scopes and storage: docs/03-engineering/walkthrough-handoff-2026-10-22.md,
 * E7 "Signature storage and import from Gmail or Outlook".
 */
function SignatureImportPreview() {
  const [asked, setAsked] = React.useState<SignatureSource | null>(null);
  return (
    <Card role="region" aria-labelledby="mail-signature-title" className="flex flex-col gap-[var(--space-3)]">
      <div className="flex items-center gap-[var(--space-2)]">
        <h3 id="mail-signature-title" className="font-sans text-[length:var(--text-md)] font-semibold text-[var(--ink)]">
          Signature
        </h3>
        {/* Preview: no signature is read or stored; handoff E7 "Signature
            storage and import from Gmail or Outlook". */}
        <PreviewChip />
      </div>
      <p className={`${TEXT} text-[var(--ink-secondary)]`}>
        Import the signature you already use in Gmail or Outlook, so mail sent from Conductia ends the same way.
        Importing needs your permission for Conductia to read your mailbox settings, which you give once to Google or
        Microsoft.
      </p>
      <div className="flex flex-wrap gap-[var(--space-2)]">
        {(Object.keys(SIGNATURE_SOURCE) as SignatureSource[]).map((source) => (
          <Button key={source} size="sm" variant="secondary" onClick={() => setAsked(source)}>
            Import from {SIGNATURE_SOURCE[source]}
          </Button>
        ))}
      </div>
      <p role="status" className={`${TEXT} text-[var(--ink-secondary)] empty:hidden`}>
        {asked
          ? `Nothing was imported. ${SIGNATURE_SOURCE[asked]} import needs that permission, and engineers are wiring it. Conductia read and saved nothing.`
          : ''}
      </p>
    </Card>
  );
}

type Me = { email: string | null; overseer: boolean; failed: boolean };

/**
 * The caller's address and whether they are the CCO or an admin, mirroring the
 * server's overseer rule (firmMailAccess). A failed read is reported, so the
 * section says so instead of silently hiding the compliance card.
 */
function useMe(): Me & { retry: () => void } {
  const [me, setMe] = React.useState<Me>({ email: null, overseer: false, failed: false });
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch('/api/v1/me', { signal: controller.signal });
        if (!res.ok) {
          setMe((prev) => ({ ...prev, failed: true }));
          return;
        }
        const body = (await res.json()) as {
          user?: { firm_role?: string | null; is_external?: boolean; email?: string | null };
        };
        // An external user is never an overseer whatever firm_role says.
        const role = body.user?.is_external ? null : (body.user?.firm_role ?? null);
        setMe({ email: body.user?.email ?? null, overseer: role === 'cco' || role === 'admin', failed: false });
      } catch {
        // Still the ordinary member's view (the server enforces it), but never silently.
        if (!controller.signal.aborted) setMe((prev) => ({ ...prev, failed: true }));
      }
    })();
    return () => controller.abort();
  }, [attempt]);
  const retry = React.useCallback(() => {
    setMe((prev) => ({ ...prev, failed: false }));
    setAttempt((n) => n + 1);
  }, []);
  return { ...me, retry };
}

/**
 * Settings › Mail: only what is Conductia's own. Your mailbox (sending from
 * your own address, and deal discovery), the signature import Preview, and,
 * for the CCO or an admin, the firm's compliance settings. Folders, rules and
 * everything else about mail stay in the banker's own mail client. Mounted
 * by the Settings registry (src/lib/settings/sections/mail.tsx); takes no props.
 */
export function MailSettingsSection() {
  const canConnectDiscovery = useFlag('deal_discovery');
  const me = useMe();
  return (
    <div className="flex max-w-[640px] flex-col gap-[var(--space-4)]">
      <p className={`${TEXT} text-[var(--ink-secondary)]`}>
        Conductia sends and screens mail for your deals. Folders, rules, out of office and the rest stay in your own
        mail client.
      </p>
      {me.failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-[var(--space-2)]">
          <p className={`${TEXT} text-[var(--ink-secondary)]`}>Some mail settings could not be loaded. Try again.</p>
          <Button size="sm" variant="secondary" aria-label="Try again loading mail settings" onClick={me.retry}>
            {TRY_AGAIN_COPY}
          </Button>
        </div>
      ) : null}
      <MailboxSendingCard selfEmail={me.email} />
      {/* Always mounted: a member who consented can stop while the flag is off. */}
      <MailboxConsentCard canConnect={canConnectDiscovery} />
      <SignatureImportPreview />
      {me.overseer ? <ComplianceSettingsCard /> : null}
    </div>
  );
}
