import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SCREEN_TOKEN_MAX_AGE_MS,
  hasScreenTokenKey,
  mintScreenToken,
  screenTokenRecord,
  screenedFromToken,
  verifyScreenToken,
  type ScreenTokenRecord,
} from '../src/lib/compliance/screenToken';

/*
 * The send-as-is token (#192 slice 2b): the FIRST screen's read, HMAC-bound to
 * the exact content the sender saw it about. A resubmit that presents a valid
 * token skips the second (nondeterministic, paid) LLM call and records what
 * the sender actually approved.
 */

const sha = createHash('sha256').update('Process update\n\nHonestly their CFO is a clown.').digest('hex');

const subject = { sha, actorId: 'md-1', dealId: 'deal-1' };

const record: ScreenTokenRecord = {
  ...subject,
  verdict: 'hold',
  reasons: ['Front-page risk.'],
  holdCause: 'reputational',
  rewrite: 'Their CFO has struggled to land the narrative.',
  rewriteIsBody: true,
  llmChecked: true,
  preApproved: [],
  lexicon: { version: 'lex-2026-08-19', signals: [] },
  modelDecision: { allowed: true, basis: 'synthetic_tenant', purpose: 'mail_send_screen', tenantId: 'tenant-1' },
  iat: 1_756_000_000_000,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('screen token', () => {
  it('round-trips the first screen record, bound to the content sha', () => {
    vi.stubEnv('OUTBOX_SCREEN_SECRET', 'secret-a');
    const token = mintScreenToken(record);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyScreenToken(token, subject, { now: record.iat + 1_000 })).toEqual(record);
  });

  it('carries the first screen gate decision, and a replay rebuilds the screen with it (#339)', () => {
    vi.stubEnv('OUTBOX_SCREEN_SECRET', 'secret-a');
    const withheld: ScreenTokenRecord = {
      ...record,
      llmChecked: false,
      modelDecision: { allowed: false, reason: 'not_local', purpose: 'mail_send_screen', tenantId: 'tenant-1' },
    };
    const verified = verifyScreenToken(mintScreenToken(withheld), subject, { now: record.iat + 1_000 });
    expect(verified?.modelDecision).toEqual(withheld.modelDecision);
    expect(screenedFromToken(verified!)).toMatchObject({
      llmChecked: false,
      modelDecision: withheld.modelDecision,
      llmWithheld: 'not_local',
    });
    expect(screenedFromToken(record)).not.toHaveProperty('llmWithheld');
  });

  it('rejects a genuine token with no gate decision, or one for another purpose (#339)', () => {
    vi.stubEnv('OUTBOX_SCREEN_SECRET', 'secret-a');
    const now = record.iat + 1_000;
    const preGate: Partial<ScreenTokenRecord> = { ...record };
    delete preGate.modelDecision;
    expect(verifyScreenToken(mintScreenToken(preGate as ScreenTokenRecord), subject, { now })).toBeNull();
    const codename = { ...record, modelDecision: { ...record.modelDecision, purpose: 'codename_suggest' as const } };
    expect(verifyScreenToken(mintScreenToken(codename), subject, { now })).toBeNull();
  });

  it("carries Jev's second opinion the sender saw (D82) through mint, verify and rebuild", () => {
    vi.stubEnv('OUTBOX_SCREEN_SECRET', 'secret-a');
    const secondOpinion = { outcome: 'kept' as const, threshold: 0.05, clearedReasons: [] };
    const screened = {
      verdict: 'blocked' as const,
      reasons: ['Promissory.'],
      llmChecked: false,
      modelDecision: record.modelDecision,
      secondOpinion,
    };
    const token = mintScreenToken(screenTokenRecord(screened, subject, record.iat));
    const verified = verifyScreenToken(token, subject, { now: record.iat + 1_000 });
    expect(verified?.secondOpinion).toEqual(secondOpinion);
    expect(screenedFromToken(verified!).secondOpinion).toEqual(secondOpinion);
  });

  it('rejects a token whose payload was edited (signature no longer matches)', () => {
    vi.stubEnv('OUTBOX_SCREEN_SECRET', 'secret-a');
    const token = mintScreenToken(record);
    const [payload, sig] = token.split('.');
    const edited = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), verdict: 'compliant' }),
    ).toString('base64url');
    expect(verifyScreenToken(`${edited}.${sig}`, subject, { now: record.iat + 1_000 })).toBeNull();
  });

  it('rejects a token minted under another secret', () => {
    vi.stubEnv('OUTBOX_SCREEN_SECRET', 'secret-a');
    const token = mintScreenToken(record);
    vi.stubEnv('OUTBOX_SCREEN_SECRET', 'secret-b');
    expect(verifyScreenToken(token, subject, { now: record.iat + 1_000 })).toBeNull();
  });

  it('rejects a token for OTHER content: the sender edited the text after the screen', () => {
    vi.stubEnv('OUTBOX_SCREEN_SECRET', 'secret-a');
    const token = mintScreenToken(record);
    const otherSha = createHash('sha256').update('something else').digest('hex');
    expect(verifyScreenToken(token, { ...subject, sha: otherSha }, { now: record.iat + 1_000 })).toBeNull();
  });

  it('rejects a token presented by another sender or for another deal: not a bearer capability', () => {
    vi.stubEnv('OUTBOX_SCREEN_SECRET', 'secret-a');
    const token = mintScreenToken(record);
    const now = record.iat + 1_000;
    expect(verifyScreenToken(token, { ...subject, actorId: 'md-2' }, { now })).toBeNull();
    expect(verifyScreenToken(token, { ...subject, dealId: 'deal-2' }, { now })).toBeNull();
    expect(verifyScreenToken(token, { ...subject, dealId: null }, { now })).toBeNull();
  });

  it('a deal-less screen binds to "no deal" — a token minted without a deal is not valid for one', () => {
    vi.stubEnv('OUTBOX_SCREEN_SECRET', 'secret-a');
    const token = mintScreenToken({ ...record, dealId: null });
    const now = record.iat + 1_000;
    expect(verifyScreenToken(token, { ...subject, dealId: null }, { now })).not.toBeNull();
    expect(verifyScreenToken(token, subject, { now })).toBeNull();
  });

  it('a token without an envelope verifies exactly as before, and minting adds none (#490)', () => {
    vi.stubEnv('OUTBOX_SCREEN_SECRET', 'secret-a');
    const screened = { verdict: 'hold' as const, reasons: ['Front-page risk.'], llmChecked: true, modelDecision: record.modelDecision };
    const minted = screenTokenRecord(screened, subject, record.iat);
    expect(minted).not.toHaveProperty('envelope');
    const now = record.iat + 1_000;
    expect(verifyScreenToken(mintScreenToken(minted), subject, { now })).toEqual(minted);
    expect(verifyScreenToken(mintScreenToken(record), subject, { now })).toEqual(record);
  });

  it('an envelope-bound token is honored only for the same envelope (#490)', () => {
    vi.stubEnv('OUTBOX_SCREEN_SECRET', 'secret-a');
    const screened = { verdict: 'hold' as const, reasons: ['Front-page risk.'], llmChecked: true, modelDecision: record.modelDecision };
    const bound = { ...subject, envelope: 'env-a' };
    const token = mintScreenToken(screenTokenRecord(screened, bound, record.iat));
    const now = record.iat + 1_000;
    expect(verifyScreenToken(token, bound, { now })?.envelope).toBe('env-a');
    expect(verifyScreenToken(token, { ...subject, envelope: 'env-b' }, { now })).toBeNull();
    expect(verifyScreenToken(token, subject, { now })).toBeNull();
    // An unbound token does not carry over to a send that binds an envelope.
    expect(verifyScreenToken(mintScreenToken(record), bound, { now })).toBeNull();
  });

  it('rejects an expired token; a stale screen is re-run, not replayed', () => {
    vi.stubEnv('OUTBOX_SCREEN_SECRET', 'secret-a');
    const token = mintScreenToken(record);
    expect(verifyScreenToken(token, subject, { now: record.iat + SCREEN_TOKEN_MAX_AGE_MS + 1 })).toBeNull();
    expect(verifyScreenToken(token, subject, { now: record.iat + SCREEN_TOKEN_MAX_AGE_MS - 1 })).not.toBeNull();
  });

  it('garbage and malformed input verify to null, never throw', () => {
    vi.stubEnv('OUTBOX_SCREEN_SECRET', 'secret-a');
    for (const bad of ['', 'nodot', 'a.b', 'stale-or-forged-token', `${'x'.repeat(10)}.${'y'.repeat(10)}`]) {
      expect(verifyScreenToken(bad, subject, { now: record.iat })).toBeNull();
    }
  });

  it('falls back to a purpose-derived key from the invite pepper when no dedicated secret is set', () => {
    vi.stubEnv('OUTBOX_SCREEN_SECRET', '');
    vi.stubEnv('INVITE_VERIFICATION_PEPPER', 'pepper-only');
    const token = mintScreenToken(record);
    expect(verifyScreenToken(token, subject, { now: record.iat })).toEqual(record);
  });

  it('with neither secret set, minting fails loudly (no unsigned tokens)', () => {
    vi.stubEnv('OUTBOX_SCREEN_SECRET', '');
    vi.stubEnv('INVITE_VERIFICATION_PEPPER', '');
    expect(() => mintScreenToken(record)).toThrow(/OUTBOX_SCREEN_SECRET/);
    expect(hasScreenTokenKey()).toBe(false);
    vi.stubEnv('INVITE_VERIFICATION_PEPPER', 'pepper-only');
    expect(hasScreenTokenKey()).toBe(true);
  });
});
