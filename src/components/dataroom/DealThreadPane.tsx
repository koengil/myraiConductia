'use client';

import * as React from 'react';

import { MailComposer, type ComposerSeed } from '@/components/mail/MailComposer';
import { threadSubject } from '@/lib/mail/confidential';
import { formatDateTime } from '@/lib/format/date';
import { useCanonicalDealCode } from '@/lib/mail/dealRef';
import { useCurrentUser } from '@/lib/auth/useCurrentUser';

/**
 * Deal thread (#339): one conversation from the reader's own mailbox, opened
 * from the Deal email list. The server decides what the thread holds
 * (GET /api/v1/discovery/deal-email/thread): only the reader's own deal-linked
 * messages, each with the top of its body (quoted history dropped), oldest
 * first. A colleague's message in the same conversation never arrives here.
 * Reply opens the platform composer, so the pre-send screen, the recipient
 * check and the risk bands run as on any send, and the message leaves through
 * the banker's connected mailbox when there is one (#490). The composer echoes
 * the route's signed replyToken; the outbox takes In-Reply-To and References
 * from it, never from the page, so a Gmail or platform reply lands in the
 * recipient's conversation (a Microsoft 365 send carries no threading yet, Issue #96,
 * and the pane says so above the composer). A reply that adds anyone who was
 * not on the thread goes out unthreaded too (the token carries the thread's
 * participants).
 * Look and copy: design to confirm.
 */

/** The wire shape of the thread route, declared here so this client file imports nothing from src/lib/discovery/api. */
type ThreadAddress = { address: string; name: string | null };
type ThreadMessage = {
  sourceItemId: string;
  sentAt: string | null;
  from: ThreadAddress | null;
  to: ThreadAddress[];
  cc: ThreadAddress[];
  subject: string;
  body: string;
  internetMessageId: string | null;
  fromSelf: boolean;
};
/** replyToken: the threading of a reply to the newest message, signed by the server; null sends it unthreaded. */
type Thread = { conversationId: string | null; messages: ThreadMessage[]; replyToken: string | null };

type Loaded = { key: string; ok: true; thread: Thread } | { key: string; ok: false; message: string };

/** "Sep 18, 2026, 3:00 PM UTC", fixed to UTC so the server and every reader agree on the stamp. */
function formatStamp(iso: string): string {
  const label = formatDateTime(iso, { timeZone: 'UTC' });
  return label ? `${label} UTC` : iso;
}

function who(a: ThreadAddress): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

/**
 * The composer seed for a reply to the newest message of the thread: to its sender, or, when the reader sent it,
 * to its recipients, so a reply never comes back to the reader.
 */
export function replySeed(thread: Thread): ComposerSeed | null {
  const last = thread.messages.at(-1);
  if (!last) return null;
  const to = last.fromSelf ? last.to.map((a) => a.address) : last.from ? [last.from.address] : [];
  const quote = [
    '',
    '',
    '---- Original message ----',
    `From: ${last.from ? who(last.from) : 'Unknown sender'}`,
    `Subject: ${last.subject}`,
    `Sent: ${last.sentAt ? formatStamp(last.sentAt) : 'Undated'}`,
    '',
    last.body,
  ].join('\n');
  return {
    to: to.join(', '),
    subject: threadSubject(last.subject, 'Re'),
    bodyHtml: escapeHtml(quote),
    ...(thread.replyToken ? { replyToken: thread.replyToken } : {}),
  };
}

function ThreadMessageCard({ message }: { message: ThreadMessage }) {
  return (
    <article
      aria-label={`Message from ${message.from ? (message.from.name ?? message.from.address) : 'an unknown sender'}`}
      className="flex flex-col gap-[var(--space-2)] border-b border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-3)] last:border-b-0"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-[var(--space-3)] gap-y-[2px]">
        <span className="text-[length:var(--text-base)] font-medium text-[var(--ink)]">
          {message.from ? who(message.from) : 'Unknown sender'}
        </span>
        <span className="font-mono text-[length:var(--text-xs)] tabular-nums text-[var(--ink-tertiary)]">
          {message.sentAt ? formatStamp(message.sentAt) : 'Undated'}
        </span>
      </header>
      {message.to.length > 0 ? (
        <p className="m-0 text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">To: {message.to.map(who).join(', ')}</p>
      ) : null}
      {message.cc.length > 0 ? (
        <p className="m-0 text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">Cc: {message.cc.map(who).join(', ')}</p>
      ) : null}
      <p className="m-0 whitespace-pre-wrap break-words text-[length:var(--text-sm)] text-[var(--ink)]">{message.body}</p>
    </article>
  );
}

export function DealThreadPane({
  dealCode,
  sourceItemId,
  onBack,
}: {
  dealCode: string;
  sourceItemId: string;
  onBack: () => void;
}) {
  const key = `${dealCode}\u0000${sourceItemId}`;
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [reply, setReply] = React.useState<{ key: string; state: 'open' | 'sent' } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `/api/v1/discovery/deal-email/thread?deal=${encodeURIComponent(dealCode)}&item=${encodeURIComponent(sourceItemId)}`,
          { headers: { Accept: 'application/json' } },
        );
        if (cancelled) return;
        if (!res.ok) {
          setLoaded({
            key,
            ok: false,
            message: res.status === 404 ? 'This thread is no longer available to you.' : 'The thread failed to load.',
          });
          return;
        }
        const thread = (await res.json()) as Thread;
        if (cancelled) return;
        setLoaded({ key, ok: true, thread });
      } catch {
        if (cancelled) return;
        setLoaded({ key, ok: false, message: 'Network error. Check your connection and try again.' });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [dealCode, sourceItemId, key]);

  // A result for another message is not this message's result: show loading until the matching one arrives.
  const current = loaded?.key === key ? loaded : null;
  const subject = current?.ok ? (current.thread.messages.at(-1)?.subject ?? '') : '';
  const seed = current?.ok ? replySeed(current.thread) : null;
  const replyState = reply?.key === key ? reply.state : null;
  // The reply carries the deal's canonical code from the deal listing, never
  // the raw route segment. UI guard only. The outbox route still sends
  // untagged mail without recipient review (handoff E24).
  const { code: canonicalCode, pending: codePending, unavailable: listUnavailable } = useCanonicalDealCode(dealCode);
  // The sender's own address, so same-domain replies follow the same rule as Mail.
  const { state: userState } = useCurrentUser();
  const senderEmail = userState.status === 'ready' ? (userState.data.user?.email ?? null) : null;

  return (
    <section
      aria-label="Deal thread"
      className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)]"
    >
      <header className="flex items-center gap-[var(--space-3)] border-b border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-3)]">
        <button
          type="button"
          onClick={onBack}
          className="rounded-[8px] text-[length:var(--text-sm)] font-medium text-[var(--ink-secondary)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          Back to deal email
        </button>
        <h2 className="min-w-0 flex-1 truncate text-[length:var(--text-md)] font-semibold text-[var(--ink)]">
          {subject || 'Thread'}
        </h2>
        {seed && replyState !== 'open' ? (
          <button
            type="button"
            onClick={() => setReply({ key, state: 'open' })}
            className="inline-flex shrink-0 items-center rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-3)] py-[7px] text-[length:var(--text-sm)] font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2"
          >
            Reply
          </button>
        ) : null}
      </header>
      {current === null ? (
        <p className="px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
          Loading thread.
        </p>
      ) : !current.ok ? (
        <p
          role="alert"
          className="px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-sm)] font-medium text-[var(--negative)]"
        >
          {current.message}
        </p>
      ) : (
        <div>
          {current.thread.messages.map((message) => (
            <ThreadMessageCard key={message.sourceItemId} message={message} />
          ))}
          {replyState === 'sent' ? (
            <p
              role="status"
              className="border-t border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
            >
              Reply sent.
            </p>
          ) : null}
          {seed && replyState === 'open' ? (
            <div className="border-t border-[var(--stroke)]">
              {/* Martín's review of PR #642: say so before a Microsoft 365 reply leaves unthreaded (Issue #96). */}
              <p className="px-[var(--space-4)] pt-[var(--space-3)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                Sent from a Microsoft 365 mailbox, this reply arrives as a new message, not in the conversation. Adding
                someone who was not on the thread also sends it as a new message.
              </p>
              <MailComposer
                dealRef={canonicalCode}
                dealRefPending={codePending}
                dealRefUnavailable={listUnavailable}
                senderEmail={senderEmail}
                seed={seed}
                onSent={(status) => {
                  if (status === 'sent') setReply({ key, state: 'sent' });
                }}
                onDiscard={() => setReply(null)}
              />
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

export default DealThreadPane;
