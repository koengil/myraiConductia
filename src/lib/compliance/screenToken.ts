import { createHmac, timingSafeEqual } from 'node:crypto';

import type { ModelDecisionRecord } from '@/lib/ai/modelPolicy';

import type { LexiconHit } from './lexicon';
import type { HoldCause, ScreenedVerdict } from './llm';
import type { SecondOpinionRecord } from './secondOpinion';

/**
 * The send-as-is token (#192 slice 2b).
 *
 * The Risk Patcher returns the screen's read to the sender; "send as-is"
 * comes back as a second request. Before this slice that request re-ran the
 * full screen — a second, paid, NONDETERMINISTIC LLM call whose read (not
 * the one the sender saw) became the record. The token now carries the
 * FIRST screen's read itself, HMAC-signed by the server and bound to the
 * exact content it was about (a per-field digest — the fields are screened
 * separately, so the binding must not collapse decompositions), to the
 * SENDER, and to the deal, so the resubmit can skip the second call and
 * record precisely what THIS sender approved. It is not a bearer capability:
 * another user, or another deal, cannot inherit a screen.
 *
 * The token also carries the model gate's decision for that first screen
 * (#339), so a replay records which gate produced the read it applies. A
 * token minted before the gate carries none and is screened afresh.
 *
 * Not in the token, by design: the ephemeral heat number (Storm: display at
 * send time, never persist — and a send-as-is is always Queued anyway).
 *
 * Format: base64url(JSON record) + "." + base64url(HMAC-SHA256). Opaque to
 * the client; the composer only echoes it.
 */

/** What a token is bound to: the content, the sender, the deal. */
export type ScreenSubject = {
  /** sha256 of the screened fields as a JSON array — what the read was ABOUT. */
  sha: string;
  actorId: string;
  dealId: string | null;
  /** Optional digest of the recipients and the sending connection (#490): when
   *  set, a token is honored only for the same envelope. The connection is its
   *  row id, which every reconnect replaces, so a reconnect screens afresh. Absent = unbound, so
   *  a token minted without one verifies exactly as before. */
  envelope?: string;
};

export type ScreenTokenRecord = ScreenSubject & {
  verdict: ScreenedVerdict['verdict'];
  reasons: string[];
  holdCause?: HoldCause;
  rewrite?: string;
  rewriteIsBody?: boolean;
  llmChecked: boolean;
  preApproved?: string[];
  lexicon?: { version: string; signals: LexiconHit[] };
  /** The model gate's decision for the first screen (#339). */
  modelDecision: ModelDecisionRecord;
  /** Jev's second opinion the sender saw (D82): a send-as-is records it too. */
  secondOpinion?: SecondOpinionRecord;
  /** Mint time, ms since epoch. */
  iat: number;
};

/** A screen older than this is re-run, not replayed. */
export const SCREEN_TOKEN_MAX_AGE_MS = 60 * 60 * 1000;

/** Domain-separates the fallback key from the invite pepper's own use. */
const KEY_PURPOSE = 'conductia:outbox-screen-token:v1';

export const SCREEN_TOKEN_KEY_MISSING = 'OUTBOX_SCREEN_SECRET (or INVITE_VERIFICATION_PEPPER) is not set';

function signingKeyOrNull(): Buffer | null {
  const dedicated = process.env.OUTBOX_SCREEN_SECRET;
  if (dedicated) return Buffer.from(dedicated, 'utf8');
  // Every environment already carries the invite pepper; derive a
  // purpose-specific key from it so a missing dedicated secret never ships an
  // unsigned token (and never reuses the pepper raw).
  const pepper = process.env.INVITE_VERIFICATION_PEPPER;
  if (pepper) return createHmac('sha256', pepper).update(KEY_PURPOSE).digest();
  return null;
}

/** Whether a token can be minted at all — the send path checks this BEFORE
 *  it screens or writes anything, so a misconfigured environment fails
 *  cleanly rather than after the audit row is committed. */
export function hasScreenTokenKey(): boolean {
  return signingKeyOrNull() !== null;
}

function signingKey(): Buffer {
  const key = signingKeyOrNull();
  if (!key) throw new Error(SCREEN_TOKEN_KEY_MISSING);
  return key;
}

function sign(payload: string): Buffer {
  return createHmac('sha256', signingKey()).update(payload, 'utf8').digest();
}

export function mintScreenToken(record: ScreenTokenRecord): string {
  const payload = Buffer.from(JSON.stringify(record), 'utf8').toString('base64url');
  return `${payload}.${sign(payload).toString('base64url')}`;
}

/** The first screen's record when `token` is genuine, unexpired, and about
 *  exactly this subject (content, sender, deal, and envelope when either side
 *  carries one); null otherwise — a null is not an error, it is "screen it
 *  afresh". Never throws on malformed input. */
export function verifyScreenToken(
  token: unknown,
  subject: ScreenSubject,
  opts: { now?: number; maxAgeMs?: number } = {},
): ScreenTokenRecord | null {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let expected: Buffer;
  try {
    expected = sign(payload);
  } catch {
    return null;
  }
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let record: ScreenTokenRecord;
  try {
    record = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ScreenTokenRecord;
  } catch {
    return null;
  }
  if (typeof record !== 'object' || record === null) return null;
  if (record.sha !== subject.sha) return null;
  if (record.actorId !== subject.actorId) return null;
  if ((record.dealId ?? null) !== (subject.dealId ?? null)) return null;
  if ((record.envelope ?? null) !== (subject.envelope ?? null)) return null;
  if (typeof record.iat !== 'number') return null;
  // A pre-gate token (#339) cannot say which gate produced its read, and only
  // a send screen's read can be replayed onto a send.
  if (typeof record.modelDecision !== 'object' || record.modelDecision === null) return null;
  if (typeof record.modelDecision.allowed !== 'boolean') return null;
  if (record.modelDecision.purpose !== 'mail_send_screen') return null;
  const now = opts.now ?? Date.now();
  if (now - record.iat > (opts.maxAgeMs ?? SCREEN_TOKEN_MAX_AGE_MS)) return null;
  return record;
}

/** The token record for a screen's read. */
export function screenTokenRecord(
  screened: ScreenedVerdict,
  subject: ScreenSubject,
  now = Date.now(),
): ScreenTokenRecord {
  return {
    ...subject,
    verdict: screened.verdict,
    reasons: screened.reasons,
    ...(screened.holdCause ? { holdCause: screened.holdCause } : {}),
    ...(screened.rewrite !== undefined ? { rewrite: screened.rewrite } : {}),
    ...(screened.rewriteIsBody !== undefined ? { rewriteIsBody: screened.rewriteIsBody } : {}),
    llmChecked: screened.llmChecked,
    ...(screened.preApproved ? { preApproved: screened.preApproved } : {}),
    ...(screened.lexicon ? { lexicon: screened.lexicon } : {}),
    modelDecision: screened.modelDecision,
    ...(screened.secondOpinion ? { secondOpinion: screened.secondOpinion } : {}),
    iat: now,
  };
}

/** The screen the sender saw, rebuilt from a verified token — the shape the
 *  send path records, with the first screen's gate decision. Heat is absent
 *  on purpose. */
export function screenedFromToken(record: ScreenTokenRecord): ScreenedVerdict {
  return {
    verdict: record.verdict,
    reasons: record.reasons,
    ...(record.rewrite !== undefined ? { rewrite: record.rewrite } : {}),
    ...(record.rewriteIsBody !== undefined ? { rewriteIsBody: record.rewriteIsBody } : {}),
    llmChecked: record.llmChecked,
    ...(record.holdCause ? { holdCause: record.holdCause } : {}),
    ...(record.preApproved ? { preApproved: record.preApproved } : {}),
    ...(record.lexicon ? { lexicon: record.lexicon } : {}),
    modelDecision: record.modelDecision,
    ...(!record.modelDecision.allowed && record.modelDecision.reason
      ? { llmWithheld: record.modelDecision.reason }
      : {}),
    ...(record.secondOpinion ? { secondOpinion: record.secondOpinion } : {}),
  };
}
