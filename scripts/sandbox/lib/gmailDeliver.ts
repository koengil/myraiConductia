import type { googleOperatorKit } from '../../../src/lib/mailboxAccess/readers';
import { GOOGLE_TOOL_SCOPE } from '../../../src/lib/constants/googleReader';
import { buildMultipartRelated, newBoundary } from '../../google/lib/multipart';
import {
  assertSandboxMailbox,
  assertSandboxMailAddress,
  collectAddresses,
} from './allowlist';
import { SANDBOX_MAILER_SA } from './domains';
import { SANDBOX_HEADER_RUN } from './generate';
import { buildSandboxRfc822 } from './rfc822';
import type { SandboxMessage } from './types';

export { SANDBOX_MAILER_SA };

export type DeliverStats = { sent: number; skipped: number; failed: number; errors: string[] };

export type GmailDeliverOptions = {
  runTag: string;
  serviceAccountEmail?: string;
};

type GoogleKit = ReturnType<typeof googleOperatorKit>;

const IMPORT_URL = (address: string): string =>
  `https://gmail.googleapis.com/upload/gmail/v1/users/${encodeURIComponent(address)}/messages/import` +
  '?internalDateSource=dateHeader&neverMarkSpam=true&uploadType=multipart';

const INSERT_SCOPE = GOOGLE_TOOL_SCOPE.GMAIL_INSERT_SEEDING;
const READ_SCOPE = GOOGLE_TOOL_SCOPE.GMAIL_MODIFY_OVERGRANT_PROBE;

function rfc822MsgIdQuery(messageId: string): string {
  const inner = messageId.startsWith('<') ? messageId.slice(1, -1) : messageId;
  return `rfc822msgid:${inner}`;
}

function runTagQuery(runTag: string): string {
  return `${SANDBOX_HEADER_RUN}:${runTag}`;
}

function labelForRun(runTag: string): string {
  return `ConductiaSandbox/${runTag}`;
}

export function createSandboxGmailDeliverer(kit: GoogleKit, opts: { serviceAccountEmail?: string } = {}) {
  const { GoogleHttpError, createCallerTokenSource, createDelegatedTokenCache, googleFetch, googleJson } = kit;
  const callerSa = opts.serviceAccountEmail ?? SANDBOX_MAILER_SA;
  const tokens = createDelegatedTokenCache({ callerToken: createCallerTokenSource() });
  const identity = { tenantId: 'sandbox-gmail', serviceAccountEmail: callerSa };

  async function importMessage(
    mailbox: string,
    message: SandboxMessage,
    threadId: string | undefined,
    labelIds: string[],
  ): Promise<string | undefined> {
    assertSandboxMailbox(mailbox);
    assertSandboxMailAddress(message.from.address);
    for (const email of collectAddresses(message)) assertSandboxMailAddress(email);

    const getToken = tokens.forSubject(identity, mailbox, INSERT_SCOPE);
    const raw = await buildSandboxRfc822(message);
    const boundary = newBoundary();
    const metadata: { labelIds: string[]; threadId?: string } = { labelIds };
    if (threadId) metadata.threadId = threadId;
    const body = buildMultipartRelated(boundary, metadata, raw, 'message/rfc822');
    const res = await googleFetch(
      IMPORT_URL(mailbox),
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: body as unknown as BodyInit,
      },
      { getToken },
    );
    const imported = (await res.json()) as { threadId?: string };
    return imported.threadId;
  }

  async function messageExists(mailbox: string, messageId: string): Promise<boolean> {
    const getToken = tokens.forSubject(identity, mailbox, INSERT_SCOPE);
    try {
      const found = await googleJson<{ messages?: unknown[] }>(
        `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(mailbox)}/messages?includeSpamTrash=true&maxResults=1&q=${encodeURIComponent(rfc822MsgIdQuery(messageId))}`,
        { getToken, maxAttempts: 2 },
      );
      return (found.messages?.length ?? 0) > 0;
    } catch (error) {
      if (error instanceof GoogleHttpError && (error.status === 403 || error.status === 401)) return false;
      throw error;
    }
  }

  async function deliverMessages(messages: SandboxMessage[], options: GmailDeliverOptions): Promise<DeliverStats> {
    const stats: DeliverStats = { sent: 0, skipped: 0, failed: 0, errors: [] };
    const threadByMailbox = new Map<string, Map<string, string>>();
    const runLabel = labelForRun(options.runTag);

    for (const message of messages) {
      const mailbox = message.from.address.toLowerCase();
      try {
        if (await messageExists(mailbox, message.messageId)) {
          stats.skipped += 1;
          continue;
        }
        const threads = threadByMailbox.get(mailbox) ?? new Map<string, string>();
        threadByMailbox.set(mailbox, threads);
        let threadId = threads.get(message.threadKey);
        if (!threadId && message.inReplyTo) {
          threadId = threads.get(`msg:${message.inReplyTo}`) ?? threadId;
        }
        const nextThreadId = await importMessage(mailbox, message, threadId, ['INBOX', runLabel]);
        if (nextThreadId) {
          threads.set(message.threadKey, nextThreadId);
          threads.set(`msg:${message.messageId}`, nextThreadId);
        }
        stats.sent += 1;
      } catch (error) {
        stats.failed += 1;
        const reason = error instanceof Error ? error.message : String(error);
        stats.errors.push(`${message.key} (${mailbox}): ${reason}`);
      }
    }
    return stats;
  }

  async function resetRunMailboxes(addresses: string[], runTag: string): Promise<number> {
    const label = labelForRun(runTag);
    const q = encodeURIComponent(`label:${label}`);
    let trashed = 0;
    for (const address of addresses) {
      assertSandboxMailbox(address);
      const getToken = tokens.forSubject(identity, address, READ_SCOPE);
      let pageToken: string | undefined;
      do {
        const url =
          `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(address)}/messages?maxResults=100&q=${q}` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
        const body = await googleJson<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(url, {
          getToken,
        });
        for (const hit of body.messages ?? []) {
          await googleFetch(
            `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(address)}/messages/${encodeURIComponent(hit.id)}/trash`,
            { method: 'POST' },
            { getToken },
          );
          trashed += 1;
        }
        pageToken = body.nextPageToken;
      } while (pageToken);
    }
    return trashed;
  }

  return { deliverMessages, resetRunMailboxes, callerSa };
}
