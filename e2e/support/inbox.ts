import { expect } from '@playwright/test';
import type { CapturedMessage } from './mailStub';

export type StubMessage = CapturedMessage;

/** The stub's origin. Mirrors the port playwright.config.ts boots it on. */
export const MAIL_STUB_URL = process.env.E2E_MAIL_STUB_URL ?? 'http://127.0.0.1:4310';

/**
 * Poll the stub until `expect` messages have arrived for this address, in
 * arrival order. Delivery is server-side and asynchronous relative to the
 * click that triggered it, so a bare read races the second send.
 */
export async function messagesFor(
  email: string,
  opts: { expect?: number; timeoutMs?: number } = {},
): Promise<StubMessage[]> {
  const wanted = opts.expect ?? 1;
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  let seen: StubMessage[] = [];

  while (Date.now() < deadline) {
    const response = await fetch(
      `${MAIL_STUB_URL}/messages?to=${encodeURIComponent(email)}`,
    );
    if (response.ok) {
      seen = ((await response.json()) as { messages: StubMessage[] }).messages;
      if (seen.length >= wanted) return seen.sort((a, b) => a.seq - b.seq);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  expect(
    seen.length,
    `expected ${wanted} message(s) for ${email}; saw ${seen.length}: ${seen
      .map((message) => message.subject)
      .join(' | ')}`,
  ).toBeGreaterThanOrEqual(wanted);
  return seen.sort((a, b) => a.seq - b.seq);
}

/** The six-digit challenge, rendered by sendInviteVerificationEmail inside <strong>. */
export function verificationCodeFrom(html: string): string {
  const match = html.match(/<strong>(\d{6})<\/strong>/);
  expect(match, `no six-digit code in: ${html.slice(0, 300)}`).toBeTruthy();
  return (match as RegExpMatchArray)[1];
}

/** The Supabase action link, rendered by sendInviteEmail as the CTA href. */
export function acceptUrlFrom(html: string): string {
  const match = html.match(/href="([^"]*\/auth\/v1\/verify[^"]*)"/);
  expect(match, `no action link in: ${html.slice(0, 300)}`).toBeTruthy();
  // The HTML is escaped for email clients; unescape the query separators.
  return (match as RegExpMatchArray)[1].replace(/&amp;/g, '&');
}

/**
 * The most recent code+link pair for an address, once `total` messages have
 * arrived. Each delivery sends exactly two, so a journey that resends or
 * re-invites reads its newest credential by the running total rather than by
 * clearing the stub between steps.
 */
export async function latestPairFor(
  email: string,
  total: number,
): Promise<{ code: StubMessage; link: StubMessage }> {
  const messages = await messagesFor(email, { expect: total });
  expect(
    messages,
    `expected ${total} message(s) for ${email}; saw ${messages.length}`,
  ).toHaveLength(total);
  const [code, link] = messages.slice(-2);
  return { code, link };
}
