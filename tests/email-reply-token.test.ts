// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_REPLY_PARTICIPANTS } from '@/lib/email/messageId';
import { mintReplyToken, REPLY_TOKEN_MAX_AGE_MS, verifyReplyToken, type ReplyTokenRecord } from '@/lib/email/replyToken';

// The reply token (#339): minted by the Deal email thread route, verified by the outbox.

const NOW = 1_800_000_000_000;
const record = (over: Partial<ReplyTokenRecord> = {}): ReplyTokenRecord => ({
  actorId: 'u-storm',
  dealCode: 'KESTR-2026-412',
  sourceItemId: 'i-2',
  inReplyTo: '<b@x.example>',
  references: ['<a@x.example>', '<b@x.example>'],
  participants: ['founder@x.example', 'storm@bank.example'],
  iat: NOW,
  ...over,
});
const subject = { actorId: 'u-storm', dealCode: 'kestr-2026-412' };

afterEach(() => vi.unstubAllEnvs());

describe('reply token', () => {
  it('round-trips for the same caller and deal, the code matched case-insensitively', () => {
    vi.stubEnv('INVITE_VERIFICATION_PEPPER', 'pepper');
    const token = mintReplyToken(record());
    expect(verifyReplyToken(token, subject, { now: NOW + 1000 })).toEqual(record());
  });

  it('refuses another caller, another deal, an expired token and a tampered one', () => {
    vi.stubEnv('INVITE_VERIFICATION_PEPPER', 'pepper');
    const token = mintReplyToken(record()) as string;
    expect(verifyReplyToken(token, { ...subject, actorId: 'u-alex' }, { now: NOW })).toBeNull();
    expect(verifyReplyToken(token, { ...subject, dealCode: 'OSPRY-2026-001' }, { now: NOW })).toBeNull();
    expect(verifyReplyToken(token, subject, { now: NOW + REPLY_TOKEN_MAX_AGE_MS + 1 })).toBeNull();
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify(record({ inReplyTo: '<forged@x>' }))).toString('base64url');
    expect(verifyReplyToken(`${forged}.${sig}`, subject, { now: NOW })).toBeNull();
    expect(verifyReplyToken(`${payload}.`, subject, { now: NOW })).toBeNull();
    expect(verifyReplyToken(42, subject, { now: NOW })).toBeNull();
  });

  it('refuses a token signed under another key', () => {
    vi.stubEnv('INVITE_VERIFICATION_PEPPER', 'pepper');
    const token = mintReplyToken(record());
    vi.stubEnv('INVITE_VERIFICATION_PEPPER', 'another');
    expect(verifyReplyToken(token, subject, { now: NOW })).toBeNull();
  });

  it('mints nothing and verifies nothing without a key', () => {
    vi.stubEnv('INVITE_VERIFICATION_PEPPER', '');
    vi.stubEnv('OUTBOX_SCREEN_SECRET', '');
    expect(mintReplyToken(record())).toBeNull();
  });

  it('refuses a signed record whose headers are not message ids', () => {
    vi.stubEnv('INVITE_VERIFICATION_PEPPER', 'pepper');
    expect(verifyReplyToken(mintReplyToken(record({ inReplyTo: 'bare@x' })), subject, { now: NOW })).toBeNull();
    expect(verifyReplyToken(mintReplyToken(record({ references: ['<a@x>\r\nBcc: x'] })), subject, { now: NOW })).toBeNull();
  });

  it('refuses a record without its participants, or with more than the cap', () => {
    vi.stubEnv('INVITE_VERIFICATION_PEPPER', 'pepper');
    const without = { ...record() } as Partial<ReplyTokenRecord>;
    delete without.participants;
    expect(verifyReplyToken(mintReplyToken(without as ReplyTokenRecord), subject, { now: NOW })).toBeNull();
    const many = Array.from({ length: MAX_REPLY_PARTICIPANTS + 1 }, (_, i) => `p${i}@x.example`);
    expect(verifyReplyToken(mintReplyToken(record({ participants: many })), subject, { now: NOW })).toBeNull();
    expect(verifyReplyToken(mintReplyToken(record({ participants: [''] })), subject, { now: NOW })).toBeNull();
  });
});
