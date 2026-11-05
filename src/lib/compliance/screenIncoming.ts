import type { NormalizedItem } from '@/lib/discovery/normalize';

import { ruleLayerReasons } from './screen';

/**
 * Compliance screening of mail read from a banker's mailbox (MVP 2 plan v5,
 * week 3: "compliance checks on incoming email"). It runs the same rule layer
 * a send runs on a message as the discovery pipeline normalizes it (subject,
 * body text with quoted history dropped, so a reply is judged on what its
 * sender wrote), plus the block a forward carries, which normalization drops
 * and forwardedBlock reads apart from it (forwarding is how material
 * information leaves a thread).
 *
 * Rules only and deterministic: no model client is reachable from here (the
 * AI layer waits on the zero data retention decision, Issue #270). Pure and
 * in memory: the worker reports counts only, because screening runs in the
 * bank's data plane (ADR-0017) and a reason quotes the matched words; where
 * per-message results live waits on Issue #264.
 */

/**
 * The most of each field the rules read on incoming mail. The promissory rules'
 * lookaheads take time that grows with the square of the text length, which is
 * harmless on what a banker types but not on outside mail (the Gmail reader
 * accepts bodies up to 25 MB): a crafted email could hold a sync for minutes.
 * 32 KB of a sender's own words, quoted history already dropped, keeps the
 * worst case near 0.06 s per field (Guillermo's review of PR #416). Text past
 * the cap is not screened.
 */
export const SCREEN_FIELD_LIMIT = 32 * 1024;

const capped = (text: string) => (text.length > SCREEN_FIELD_LIMIT ? text.slice(0, SCREEN_FIELD_LIMIT) : text);

export type IncomingScreenResult = {
  internetMessageId: string;
  /** True when the rules would have flagged this message at send time (blocked or held for review). */
  flagged: boolean;
  /** One readable reason per hit ("mnpi: walk-away"); empty when clear. */
  reasons: string[];
};

/** Screens one normalized message, with the block it forwards (forwardedBlock) when there is one. */
export function screenIncomingMessage(item: NormalizedItem, forwarded = ''): IncomingScreenResult {
  const reasons = ruleLayerReasons([capped(item.subject), capped(item.bodyText), capped(forwarded)]);
  return { internetMessageId: item.internetMessageId, flagged: reasons.length > 0, reasons };
}

/**
 * Screens the messages of a page; SharePoint documents are not mail and are
 * left out. `forwardedById` maps an Internet message id to its forwarded block.
 */
export function screenIncomingItems(
  items: readonly NormalizedItem[],
  forwardedById: ReadonlyMap<string, string> = new Map(),
): IncomingScreenResult[] {
  return items
    .filter((item) => item.kind !== 'document')
    .map((item) => screenIncomingMessage(item, forwardedById.get(item.internetMessageId)));
}

/** Counts for the worker's report: how many messages were screened and how many the rules flag. No content. */
export function screeningTally(results: readonly IncomingScreenResult[]): { screened: number; flagged: number } {
  return { screened: results.length, flagged: results.filter((r) => r.flagged).length };
}
