'use client';

import * as React from 'react';
import { Badge, Button } from '@/components/atoms';
import { recipientBoundary } from '@/lib/mail/recipientBoundary';
import { TRY_AGAIN_COPY } from '@/components/deals/DealsUnavailable';

export function RecipientBoundaryWarning({ recipients }: { recipients: readonly string[] }) {
  const [domains, setDomains] = React.useState<string[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();
    let active = true;
    async function load() {
      try {
        const response = await fetch('/api/v1/mail-domain-policy', {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Policy unavailable');
        const payload: unknown = await response.json();
        if (!payload || typeof payload !== 'object' || !('verifiedDomains' in payload) ||
            !Array.isArray(payload.verifiedDomains) ||
            !payload.verifiedDomains.every((domain: unknown) => typeof domain === 'string')) {
          throw new Error('Invalid policy');
        }
        if (active) setDomains(payload.verifiedDomains);
      } catch {
        if (active) setFailed(true);
      }
    }
    void load();
    return () => { active = false; controller.abort(); };
  }, [attempt]);

  if (!recipients.length) return null;
  const boundary = recipientBoundary(recipients, domains ?? []);
  if (boundary === 'internal') return null;
  const external = boundary === 'external';
  const detail = external
    ? 'This email includes recipients outside your organization. Review the recipients before sending.'
    : failed
      ? 'Unable to check your organization’s verified domains.'
      : domains === null
        ? 'Checking your organization’s verified domains.'
        : domains.length === 0
          ? 'No verified domains are configured for your organization.'
          : 'Complete the recipient addresses to check their domains.';

  return (
    <div role="status" className={`flex flex-wrap items-center gap-[var(--space-2)] rounded-[var(--radius-control)] p-[var(--space-3)] font-sans text-[length:var(--text-sm)] ${external ? 'bg-[var(--negative-fill)] text-[var(--negative-deep)]' : 'bg-[var(--hold-fill)] text-[var(--hold-deep)]'}`}>
      <Badge tone={external ? 'negative' : 'hold'}>
        {external ? 'External recipient' : 'Could not tell if recipients are outside the firm'}
      </Badge>
      <span>{detail}</span>
      {failed ? (
        <Button variant="secondary" size="sm" aria-label="Try again checking recipient domains" onClick={() => {
          setDomains(null);
          setFailed(false);
          setAttempt((value) => value + 1);
        }}>{TRY_AGAIN_COPY}</Button>
      ) : null}
    </div>
  );
}
