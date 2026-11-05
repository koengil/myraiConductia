'use client';

import * as React from 'react';

import { useDeals, type ListedDeal } from '@/lib/deals/useDeals';

/**
 * The deal reference every UI send carries.
 *
 * UI guard only. The outbox route still sends untagged mail without recipient
 * review (handoff E24). So the screens never hand it a raw URL segment: the
 * segment (deal code, or the deal UUID) is matched against the deal listing,
 * and the send carries that deal's canonical code, trimmed. A segment the
 * listing does not know resolves to no code at all, and the composer then
 * refuses an outside send.
 */
export function canonicalDealCode(
  deals: readonly ListedDeal[],
  segment: string | null | undefined,
): string | undefined {
  const wanted = segment?.trim();
  if (!wanted) return undefined;
  const deal = deals.find((d) => d.code?.trim() === wanted || d.id === wanted || d.uuid === wanted);
  const code = deal?.code?.trim();
  return code ? code : undefined;
}

/**
 * The canonical code for a route segment, whether the listing is still
 * loading, and, when the listing failed and no code was found, its retry: the
 * composer then says the deal list failed, never "could not match".
 */
export function useCanonicalDealCode(segment: string | null | undefined): {
  code: string | undefined;
  pending: boolean;
  unavailable: { retry: () => void } | null;
} {
  const { deals, loading, error, reload } = useDeals();
  const code = canonicalDealCode(deals, segment);
  const unavailable = React.useMemo(
    () => (error && code === undefined ? { retry: reload } : null),
    [error, code, reload],
  );
  return { code, pending: loading && code === undefined, unavailable };
}

/** The lower-cased domain of an address ("Name <a@b.com>" included), or null. */
export function emailDomain(address: string | null | undefined): string | null {
  if (!address) return null;
  const bare = (/<([^>]*)>/.exec(address)?.[1] ?? address).trim();
  const at = bare.lastIndexOf('@');
  if (at <= 0 || at === bare.length - 1) return null;
  return bare.slice(at + 1).toLowerCase();
}

/** True when there is at least one recipient and every one shares the sender's own domain. */
export function onlySenderDomain(recipients: readonly string[], senderEmail: string | null | undefined): boolean {
  const own = emailDomain(senderEmail);
  if (!own || recipients.length === 0) return false;
  return recipients.every((r) => emailDomain(r) === own);
}
