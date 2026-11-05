import { createHmac, timingSafeEqual } from 'node:crypto';

import { MAX_REPLY_PARTICIPANTS, MESSAGE_ID_RX } from './messageId';

/**
 * The reply token (#339). The Deal email thread route reads a thread under the
 * caller's own session and mints this token with the threading headers a reply
 * to it carries; the outbox only verifies it. So the outbox, which holds a
 * service-role client, never reads mailbox data, and no header text is taken
 * from the request: In-Reply-To and References are the stored Message-IDs of
 * a thread the caller could read, signed by the server and bound to the
 * caller and the deal.
 *
 * Format: base64url(JSON record) + "." + base64url(HMAC-SHA256), as the screen
 * token (src/lib/compliance/screenToken.ts), under a key of its own purpose.
 */

export type ReplyTokenRecord = {
  actorId: string;
  /** The deal code the thread was read on, uppercased. */
  dealCode: string;
  /** The deal-linked message the reply answers. */
  sourceItemId: string;
  inReplyTo: string;
  references: string[];
  /**
   * Every address on the thread the caller read (from, to, cc), lowercased. A
   * reply that adds anyone else goes out unthreaded (Martín's review of PR #642),
   * so the thread's Message-IDs never reach a party who was never on it.
   */
  participants: string[];
  /** Mint time, ms since epoch. */
  iat: number;
};

/** A reply composed later than this reads its thread again. */
export const REPLY_TOKEN_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const KEY_PURPOSE = 'conductia:reply-thread-token:v2';

function signingKeyOrNull(): Buffer | null {
  // The same secrets as the screen token (screenToken.ts), each under its own purpose, so one
  // token never verifies as the other. Rotating the invite pepper also rotates this key.
  const secret = process.env.OUTBOX_SCREEN_SECRET || process.env.INVITE_VERIFICATION_PEPPER;
  return secret ? createHmac('sha256', secret).update(KEY_PURPOSE).digest() : null;
}

function sign(payload: string, key: Buffer): Buffer {
  return createHmac('sha256', key).update(payload, 'utf8').digest();
}

/** The token, or null when no signing key is configured (the reply then goes out unthreaded). */
export function mintReplyToken(record: ReplyTokenRecord): string | null {
  const key = signingKeyOrNull();
  if (!key) return null;
  const payload = Buffer.from(JSON.stringify(record), 'utf8').toString('base64url');
  return `${payload}.${sign(payload, key).toString('base64url')}`;
}

/** The record when `token` is genuine, unexpired and minted for this caller and deal; null otherwise. Never throws. */
export function verifyReplyToken(
  token: unknown,
  subject: { actorId: string; dealCode: string },
  opts: { now?: number } = {},
): ReplyTokenRecord | null {
  if (typeof token !== 'string' || token.length > 32_000) return null;
  const key = signingKeyOrNull();
  if (!key) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = sign(payload, key);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let record: ReplyTokenRecord;
  try {
    record = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ReplyTokenRecord;
  } catch {
    return null;
  }
  if (typeof record !== 'object' || record === null) return null;
  if (record.actorId !== subject.actorId) return null;
  if (record.dealCode !== subject.dealCode.trim().toUpperCase()) return null;
  if (typeof record.iat !== 'number' || (opts.now ?? Date.now()) - record.iat > REPLY_TOKEN_MAX_AGE_MS) return null;
  if (typeof record.inReplyTo !== 'string' || !MESSAGE_ID_RX.test(record.inReplyTo)) return null;
  if (!Array.isArray(record.references) || !record.references.every((r) => typeof r === 'string' && MESSAGE_ID_RX.test(r))) {
    return null;
  }
  if (
    !Array.isArray(record.participants) ||
    record.participants.length > MAX_REPLY_PARTICIPANTS ||
    !record.participants.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 320)
  ) {
    return null;
  }
  return record;
}
