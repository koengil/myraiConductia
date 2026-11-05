'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { queueRecipientAddition } from '@/lib/team/recipientAddition';
import type { RecipientDecision } from '@/lib/mail/recipientReview';
import { recipientHandoffs } from '@/lib/mail/recipientHandoff';
import { useCanonicalDealCode } from '@/lib/mail/dealRef';
import { dealUuidOf, resolveListedDeal, useDealListSource, useDeals } from '@/lib/deals/useDeals';
import { NotOnDeal, NotOnDealStage } from '@/components/deals/DealsUnavailable';
import { DESTINATION_TITLES } from '@/lib/perspective/destinationTitles';

import { Badge, Button } from '@/components/atoms';
import type { RecipientBoundary } from '@/lib/mail/recipientBoundary';
import { resolveProjectId } from '@/lib/project/resolveProjectId';
import { threadSubject } from '@/lib/mail/confidential';
import {
  deleteDraft,
  listDrafts,
  newDraftId,
  saveDraft,
  type MailDraft,
} from '@/lib/mail/drafts';
import {
  formatBytes,
  initialsOf,
  mailTimestamp,
  sanitizeHtml,
  toPlainText,
} from '@/lib/mail/format';
import { MailComposer, type ComposerFields, type ComposerSeed } from './MailComposer';
import { formatDateTime } from '@/lib/format/date';
import { isBankSideUser } from '@/lib/navigation/navPolicy';
import type { FirmRole } from '@/lib/constants/roles';

/**
 * MailClient — the Outlook-style three-pane mail surface: folder rail,
 * message list, reading pane. Outlook structure, Conductia skin. List-first.
 *
 * Folders:
 *   Inbox    — REAL: mail received via /api/v1/inbound/webhook (per-project
 *              address scheme pending team ratification). Unread bold; count
 *              is the unread count. Reply answers for real.
 *   Drafts   — local drafts (this browser), kept per project.
 *   Sent     — outbound status 'sent' (including supervisor releases).
 *   Held     — status 'held': the supervisory queue. An overseer (CCO/admin)
 *              reviews inline — release (sends now) or reject (returns to the
 *              sender with a note). The folder Outlook does not have.
 *   Blocked  — status 'blocked' (rules) and 'rejected' (supervisor). Both
 *              never left; both offer Edit and resend.
 *
 * Scope: every folder is scoped to the ACTIVE PROJECT (?dealId on the
 * fetches), with one deliberate exception — an overseer's Held folder is the
 * tenant-wide supervisory queue (a CCO must never miss a held message because
 * they happened to be in the wrong project), so it fetches without the deal
 * filter and names each row's deal by its codename instead (never the code). Inbound mail is untagged
 * until the per-project address scheme lands, so the server keeps untagged
 * inbound visible under any deal filter — a received message never vanishes.
 */

type Folder = 'inbox' | 'sent' | 'held' | 'blocked' | 'drafts';

type AttachmentMeta = { name: string; bytes: number | null };

type OutboxMessage = {
  recipientBoundary?: RecipientBoundary | null;
  id: string;
  dealId: string | null;
  dealCode: string | null;
  status: 'sent' | 'held' | 'blocked' | 'rejected';
  /** Post-send supervision band (#192): routine | sampled | queued. */
  riskBand?: string | null;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  bodyHtml: string | null;
  reasons: string[];
  rewrite: string | null;
  provider: string | null;
  attachments: AttachmentMeta[];
  reviewNote: string | null;
  createdAt: string;
};

type InboundMessage = {
  id: string;
  from: string;
  to: string;
  cc: string[];
  subject: string;
  body: string;
  bodyHtml: string | null;
  attachments: AttachmentMeta[];
  receivedAt: string;
  read: boolean;
};

type View =
  | { kind: 'empty' }
  | { kind: 'out'; id: string }
  | { kind: 'in'; id: string }
  | { kind: 'compose'; draftId: string; seed?: ComposerSeed; focusTo?: boolean };

const FOLDERS: Array<{ id: Folder; label: string }> = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'drafts', label: 'Drafts' },
  { id: 'sent', label: 'Sent' },
  { id: 'held', label: 'Held for review' },
  { id: 'blocked', label: 'Blocked' },
];

/** Folders that exist only while they hold something (Outlook has neither). */
const CONDITIONAL_FOLDERS: ReadonlySet<Folder> = new Set(['held', 'blocked']);

/**
 * Settings › Mail, where the mailbox connection, signature and the firm's
 * compliance settings live. The same URL as settingsHref('mail'); not imported
 * from the settings registry, which pulls every section into the mail bundle.
 */
const MAIL_SETTINGS_HREF = '/settings?section=mail';

const STATUS_FOLDER: Record<OutboxMessage['status'], Folder> = {
  sent: 'sent',
  held: 'held',
  blocked: 'blocked',
  rejected: 'blocked',
};

/** Who an outbound message reached, as recorded with the send. */
function RecipientBoundaryBadge({ boundary }: { boundary: RecipientBoundary | null | undefined }) {
  switch (boundary) {
    case 'external':
      return <Badge tone="negative">External recipient</Badge>;
    case 'internal':
      return <Badge tone="neutral">Internal recipients</Badge>;
    case 'unverified':
      return <Badge tone="hold">Could not tell if recipients are outside the firm</Badge>;
    default:
      return <Badge tone="neutral">Not recorded whether recipients are outside the firm</Badge>;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

/** Drop ?folder= from the address in place (no new history entry). */
function dropFolderParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('folder')) return;
  url.searchParams.delete('folder');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

export function MailClient() {
  const params = useParams<{ projectId?: string }>();
  const projectId = params?.projectId;
  // A deal the viewer's list does not hold is not theirs, as on Book. The
  // inbox route answers such a deal with untagged mail by design (D65), so
  // its 200 cannot decide this. While the list loads, or when it failed, the
  // mail surface renders as before; a failed list keeps its own Try again.
  const { deals, loading, error } = useDeals();
  const dealSource = useDealListSource();
  const segment = projectId?.trim();
  const unlisted = Boolean(
    segment && !loading && !error && resolveListedDeal(segment, deals, dealSource) === null,
  );
  return <ProjectMailClient key={projectId ?? "global"} unlisted={unlisted} />;
}

function ProjectMailClient({ unlisted }: { unlisted: boolean }) {
  // The active project's URL segment (deal code or UUID for real deals,
  // fixture slug for the sandbox) scopes the folders. The composer gets the
  // deal's canonical code from the deal listing instead. UI guard
  // only. The outbox route still sends untagged mail without recipient
  // review (handoff E24).
  const params = useParams<{ projectId?: string }>();
  const projectId = params?.projectId;
  const { code: dealCode, pending: dealCodePending, unavailable: dealListUnavailable } = useCanonicalDealCode(projectId);
  // The overseer's queue names each row's deal by its codename, from
  // the deal listing; a deal the listing does not hold is left unnamed.
  const { deals } = useDeals();
  const codenameOf = (m: OutboxMessage): string | null =>
    deals.find((d) => (m.dealCode && d.code === m.dealCode) || (m.dealId && dealUuidOf(d) === m.dealId))?.codename ?? null;
  // Who the last sent email reached that is not on the deal yet, kept in
  // memory only: the banner links each address to where it gets added.
  const [recipientAdditions, setRecipientAdditions] = React.useState<RecipientDecision[]>([]);
  const dealRef = resolveProjectId(projectId);

  const [outbox, setOutbox] = React.useState<OutboxMessage[]>([]);
  // The overseer's tenant-wide supervisory queue — the one unscoped fetch.
  const [heldQueue, setHeldQueue] = React.useState<OutboxMessage[]>([]);
  const [inbox, setInbox] = React.useState<InboundMessage[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [loadError, setLoadError] = React.useState(false);
  const [inboxError, setInboxError] = React.useState(false);
  const [drafts, setDrafts] = React.useState<MailDraft[]>([]);
  // undefined = /api/v1/me has not answered yet; null = answered, no firm
  // role (the ordinary sender case — most bank-side users carry none).
  const [firmRole, setFirmRole] = React.useState<string | null | undefined>(undefined);
  // Settings lists Mail only for the bank side (settingsSectionsFor uses
  // isBankSideUser), so the pointer to it shows only for them. False until
  // /api/v1/me answers: an outside party is never offered a dead end.
  const [mailSettingsListed, setMailSettingsListed] = React.useState(false);
  // The sender's own address: mail only to that domain needs no deal.
  const [senderEmail, setSenderEmail] = React.useState<string | null>(null);
  const [folderChoice, setFolder] = React.useState<Folder>('inbox');
  const [view, setView] = React.useState<View>({ kind: 'empty' });
  const [search, setSearch] = React.useState('');
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [reviewNote, setReviewNote] = React.useState('');
  const [reviewBusy, setReviewBusy] = React.useState(false);
  const [reviewNotice, setReviewNotice] = React.useState<string | null>(null);

  React.useEffect(() => {
    const timer = setTimeout(() => setDrafts(listDrafts(dealRef)), 0);
    return () => clearTimeout(timer);
  }, [dealRef]);

  // A link into one folder (?folder=held, from the queued-send notification,
  // Issue #94). Read once on mount, so the param never re-opens the folder
  // later. A known folder keeps its param, so the view can be copied on; it
  // is dropped (replaceState, no new entry) once another folder opens, so the
  // address never names a folder that is not open. An unknown one is dropped.
  const linkedFolderRef = React.useRef<Folder | null>(null);
  React.useEffect(() => {
    const timer = setTimeout(() => {
      const target = new URL(window.location.href).searchParams.get('folder');
      if (!target) return;
      const known = FOLDERS.find((f) => f.id === target);
      if (known) {
        linkedFolderRef.current = known.id;
        setFolder(known.id);
      } else {
        dropFolderParam();
      }
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const scope = `?dealId=${encodeURIComponent(dealRef)}`;
        const [outRes, inRes, meRes] = await Promise.all([
          fetch(`/api/v1/outbox${scope}`, { signal: controller.signal }),
          fetch(`/api/v1/inbox${scope}`, { signal: controller.signal }),
          fetch('/api/v1/me', { signal: controller.signal }),
        ]);
        if (outRes.ok) {
          setOutbox(((await outRes.json()) as { messages: OutboxMessage[] }).messages);
          setLoadError(false);
        } else {
          setLoadError(true);
        }
        // Inbox 403 just means a non-bank-side caller; the folder shows empty.
        // Any other failure is a load error, never an empty inbox.
        if (inRes.ok) {
          setInbox(((await inRes.json()) as { messages: InboundMessage[] }).messages);
          setInboxError(false);
        } else {
          setInboxError(inRes.status !== 403);
        }
        let role: string | null = null;
        if (meRes.ok) {
          const me = (await meRes.json()) as {
            user?: { firm_role?: string | null; is_external?: boolean; email?: string | null };
          };
          setSenderEmail(me.user?.email ?? null);
          setMailSettingsListed(
            isBankSideUser({
              is_external: me.user?.is_external ?? false,
              firm_role: (me.user?.firm_role ?? null) as FirmRole | null,
              company_id: null,
              company_role: null,
            }),
          );
          // Mirror the server's overseer definition (firmMailAccess): an
          // external user is never an overseer whatever firm_role says —
          // treat them as an ordinary sender, so their banner works and the
          // review controls (which the server would 403) never render.
          role = me.user?.is_external ? null : (me.user?.firm_role ?? null);
          setFirmRole(role);
        } else {
          // /me failed: sender and overseer are indistinguishable, so the
          // banner must stay down — but never silently. Surface the load
          // error; a refresh retries the whole fetch set.
          setLoadError(true);
        }
        // The supervisory queue is tenant-wide by design — a held message
        // must reach the reviewer regardless of which project is open.
        if (role === 'cco' || role === 'admin') {
          // Two queues, one review folder (#192 slice 3): legacy pre-send
          // holds (until they drain) + the post-send queue — SENT messages
          // whose screen banded them 'queued'. Nothing holds any more; this
          // is where the CCO sees what left despite reported risk issues.
          const [heldRes, queuedRes] = await Promise.all([
            fetch('/api/v1/outbox?status=held', { signal: controller.signal }),
            fetch('/api/v1/outbox?status=sent&band=queued', { signal: controller.signal }),
          ]);
          if (heldRes.ok && queuedRes.ok) {
            const held = ((await heldRes.json()) as { messages: OutboxMessage[] }).messages.filter(
              (m) => m.status === 'held',
            );
            const queued = (
              (await queuedRes.json()) as { messages: OutboxMessage[] }
            ).messages.filter((m) => m.status === 'sent');
            setHeldQueue(
              [...held, ...queued].sort(
                (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
              ),
            );
          } else {
            // A failed refresh must never silently empty the queue the CCO
            // is working — keep the previous list and say the load failed.
            setLoadError(true);
          }
        }
      } catch {
        if (!controller.signal.aborted) {
          setLoadError(true);
          setInboxError(true);
        }
      } finally {
        if (!controller.signal.aborted) setLoaded(true);
      }
    })();
    return () => controller.abort();
  }, [refreshKey, dealRef]);

  const overseer = firmRole === 'cco' || firmRole === 'admin';
  // A deal the viewer is not on: a non-overseer gets the not-on-deal state
  // (below). An overseer keeps the tenant-wide Held queue, the one folder
  // that is not deal-scoped, and nothing that would send from this deal.
  const heldOnly = unlisted && overseer;
  const folder: Folder = heldOnly ? 'held' : folderChoice;
  React.useEffect(() => {
    if (linkedFolderRef.current === null || folder === linkedFolderRef.current) return;
    linkedFolderRef.current = null;
    dropFolderParam();
  }, [folder]);
  const unreadCount = inbox.filter((m) => !m.read).length;

  // Storm (Aug 11): a held message must pop back up, never silently queue.
  // The banner targets the SENDER (an overseer works the queue instead):
  // held = waiting on review; rejected = returned and waiting on THEM.
  // Dismissal is keyed to the exact id set on screen: any NEW held or
  // returned message changes the key, and the banner pops back up.
  const [dismissedReviewKey, setDismissedReviewKey] = React.useState<string | null>(null);
  const { heldMine, returnedMine, reviewKey } = React.useMemo(() => {
    const held = outbox.filter((m) => m.status === 'held');
    const returned = outbox.filter((m) => m.status === 'rejected');
    return {
      heldMine: held,
      returnedMine: returned,
      reviewKey: [...returned, ...held]
        .map((m) => m.id)
        .sort()
        .join('|'),
    };
  }, [outbox]);
  // /api/v1/me must have ANSWERED before showing the banner: an overseer's
  // outbox is tenant-wide by design, and presenting those rows as "returned
  // to you" before the role is known would claim other senders' messages.
  // A null firm role is an answer — it is the ordinary sender.
  const showReviewNotice =
    firmRole !== undefined && !overseer && reviewKey !== '' && reviewKey !== dismissedReviewKey;

  const openReviewNotice = () => {
    const target = returnedMine[0] ?? heldMine[0];
    if (!target) return;
    setFolder(STATUS_FOLDER[target.status]);
    setView({ kind: 'out', id: target.id });
  };

  const counts: Record<Folder, number> = React.useMemo(() => {
    const base: Record<Folder, number> = {
      inbox: unreadCount,
      drafts: drafts.length,
      sent: 0,
      held: 0,
      blocked: 0,
    };
    for (const m of outbox) base[STATUS_FOLDER[m.status]] += 1;
    // The overseer's Held count is the tenant-wide queue, not the project's.
    if (overseer) base.held = heldQueue.length;
    return base;
  }, [outbox, drafts, unreadCount, overseer, heldQueue]);

  const outList = React.useMemo(() => {
    // The overseer's review folder IS the merged queue (#192 slice 3):
    // legacy held rows plus sent-and-queued rows. Re-filtering it by status
    // would silently drop every post-send entry the folder exists to show.
    const source = folder === 'held' && overseer ? heldQueue : outbox;
    const inFolder =
      folder === 'held' && overseer
        ? source
        : source.filter((m) => STATUS_FOLDER[m.status] === folder);
    const q = search.trim().toLowerCase();
    if (!q) return inFolder;
    return inFolder.filter(
      (m) =>
        m.subject.toLowerCase().includes(q) ||
        m.body.toLowerCase().includes(q) ||
        m.to.some((t) => t.toLowerCase().includes(q)),
    );
  }, [outbox, heldQueue, overseer, folder, search]);

  const inList = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return inbox;
    return inbox.filter(
      (m) =>
        m.subject.toLowerCase().includes(q) ||
        m.body.toLowerCase().includes(q) ||
        m.from.toLowerCase().includes(q),
    );
  }, [inbox, search]);

  const selectedOut =
    view.kind === 'out'
      ? (outbox.find((m) => m.id === view.id) ??
        heldQueue.find((m) => m.id === view.id) ??
        null)
      : null;
  const selectedIn = view.kind === 'in' ? (inbox.find((m) => m.id === view.id) ?? null) : null;

  const openCompose = (seed?: ComposerSeed, draftId?: string) => {
    setView({ kind: 'compose', draftId: draftId ?? newDraftId(), seed });
  };

  const openInbound = (m: InboundMessage) => {
    setView({ kind: 'in', id: m.id });
    if (!m.read) {
      setInbox((prev) => prev.map((p) => (p.id === m.id ? { ...p, read: true } : p)));
      void fetch(`/api/v1/inbox/${m.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ read: true }),
      }).catch(() => {});
    }
  };

  const handleDraftChange = React.useCallback(
    (draftId: string) => (fields: ComposerFields) => {
      const empty =
        !fields.to && !fields.cc && !fields.bcc && !fields.subject && !toPlainText(fields.bodyHtml);
      if (empty) return;
      saveDraft({ id: draftId, ...fields, updatedAt: new Date().toISOString() }, dealRef);
      setDrafts(listDrafts(dealRef));
    },
    [dealRef],
  );

  const dropDraft = (draftId: string) => {
    deleteDraft(draftId, dealRef);
    setDrafts(listDrafts(dealRef));
  };

  const quoteOutbound = (m: OutboxMessage) =>
    escapeHtml(
      [
        '',
        '',
        '---- Original message ----',
        `To: ${m.to.join(', ')}`,
        `Subject: ${m.subject}`,
        `Sent: ${formatDateTime(m.createdAt)}`,
        '',
        m.body,
      ].join('\n'),
    );

  const quoteInbound = (m: InboundMessage) =>
    escapeHtml(
      [
        '',
        '',
        '---- Original message ----',
        `From: ${m.from}`,
        `Subject: ${m.subject}`,
        `Received: ${formatDateTime(m.receivedAt)}`,
        '',
        m.body,
      ].join('\n'),
    );

  const review = async (action: 'release' | 'reject') => {
    if (!selectedOut || reviewBusy) return;
    setReviewBusy(true);
    setReviewNotice(null);
    try {
      const res = await fetch(`/api/v1/outbox/${selectedOut.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, note: reviewNote.trim() || undefined }),
      });
      const data = (await res.json().catch(() => null)) as
        | { error?: string; releasedWithoutAttachments?: boolean }
        | null;
      if (!res.ok) {
        setReviewNotice(data?.error ?? 'The review action failed. Try again.');
        return;
      }
      setReviewNotice(
        action === 'release'
          ? data?.releasedWithoutAttachments
            ? 'Released and sent, without the original attachments (file bytes are not retained).'
            : 'Released and sent.'
          : 'Rejected and returned to the sender.',
      );
      setReviewNote('');
      setRefreshKey((k) => k + 1);
    } catch {
      setReviewNotice('The review action failed. Try again.');
    } finally {
      setReviewBusy(false);
    }
  };

  /* Folder row: Outlook's left column, active = field-gray fill. */
  const folderRow = (active: boolean) =>
    'flex min-h-[44px] w-full shrink-0 items-center justify-between gap-[var(--space-2)] rounded-[var(--radius-control)] px-[var(--space-3)] text-left font-sans text-[length:var(--text-sm)] ' +
    (active
      ? 'bg-[var(--surface-subtle)] font-medium text-[var(--ink)]'
      : 'text-[var(--ink-secondary)] hover:bg-[var(--surface-raised)] hover:text-[var(--ink)]');

  const visibleFolders = heldOnly
    ? FOLDERS.filter((f) => f.id === 'held')
    : FOLDERS.filter(
        (f) => !CONDITIONAL_FOLDERS.has(f.id) || counts[f.id] > 0 || folder === f.id || loadError,
      );
  // Below md one pane shows at a time: the list, or the open message.
  const paneOpen = view.kind !== 'empty';
  // Phone pane switch: the pane that held focus is hidden, so focus moves with
  // it. Opening a pane focuses Back, unless New message opened the composer,
  // which puts focus on To at every width. Back, and Discard, return focus to
  // the row (or New message) that opened the pane.
  const backRef = React.useRef<HTMLButtonElement | null>(null);
  const originRef = React.useRef<HTMLElement | null>(null);
  const returnFocusRef = React.useRef(false);
  const composerTakesFocus = view.kind === 'compose' && Boolean(view.focusTo);
  React.useEffect(() => {
    const phone = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767.98px)').matches;
    if (paneOpen) {
      if (phone && !composerTakesFocus) backRef.current?.focus();
    } else if (returnFocusRef.current) {
      returnFocusRef.current = false;
      originRef.current?.focus();
    }
  }, [paneOpen, composerTakesFocus]);
  const backToList = () => {
    returnFocusRef.current = true;
    setView({ kind: 'empty' });
  };

  const statusCard = (tone: 'hold' | 'negative') =>
    'flex max-w-[640px] flex-col rounded-[var(--radius-card)] border px-[var(--space-4)] py-[var(--space-3)] ' +
    (tone === 'hold'
      ? 'border-[var(--hold-fill)] bg-[var(--hold-tint)]'
      : 'border-[var(--negative-fill)] bg-[color-mix(in_srgb,var(--negative-fill)_30%,var(--surface))]');

  const listRow = (active: boolean) =>
    'flex min-h-[48px] w-full items-start gap-[var(--space-3)] border-b border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-3)] text-left ' +
    (active ? 'bg-[var(--accent-soft)]' : 'bg-[var(--surface)] hover:bg-[var(--surface-subtle)]');

  const attachmentChips = (attachments: AttachmentMeta[]) =>
    attachments.length > 0 ? (
      <ul aria-label="Attachments" className="flex flex-wrap gap-[var(--space-2)]">
        {attachments.map((a) => (
          <li
            key={a.name}
            title="Attachment record. File bytes are not retained on the platform."
            className="inline-flex items-center gap-[var(--space-2)] rounded-full border border-[var(--stroke)] bg-[var(--surface-subtle)] px-[var(--space-3)] py-1 font-sans text-[length:var(--text-xs)] text-[var(--ink)]"
          >
            <span className="max-w-[220px] truncate">{a.name}</span>
            {a.bytes != null ? (
              <span className="text-[var(--ink-tertiary)]">{formatBytes(a.bytes)}</span>
            ) : null}
          </li>
        ))}
      </ul>
    ) : null;

  const messageBody = (body: string, bodyHtml: string | null) =>
    bodyHtml ? (
      <div
        // List markers restored (Tailwind preflight strips them globally) so
        // composed lists render in the reading pane too.
        className={
          'font-sans text-[length:var(--text-base)] leading-relaxed text-[var(--ink)] ' +
          '[&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6 [&_ul]:my-1 [&_ol]:my-1'
        }
        // Sanitized: scripts/handlers stripped in sanitizeHtml.
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(bodyHtml) }}
      />
    ) : (
      <p className="whitespace-pre-wrap font-sans text-[length:var(--text-base)] leading-relaxed text-[var(--ink)]">
        {body}
      </p>
    );

  // Not on this deal: wait for /me before deciding, so the not-on-deal
  // state never flashes over an overseer's queue that is about to load.
  if (unlisted && !loaded) {
    return (
      <p className="px-[var(--space-5)] py-[var(--space-6)] font-sans text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
        Loading…
      </p>
    );
  }
  if (unlisted && !overseer) return <NotOnDealStage title={DESTINATION_TITLES.mail} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The page's one heading for assistive tech; the folders and
          reading pane carry the visible structure. */}
      <h1 className="sr-only">Mail</h1>
      {heldOnly ? (
        <div className="shrink-0 border-b border-[var(--stroke)] px-[var(--space-4)]">
          <NotOnDeal className="py-[var(--space-3)]" />
        </div>
      ) : null}
      {recipientAdditions.length > 0 && projectId ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 border-b border-[var(--stroke)] bg-[var(--surface)] p-3 font-sans text-[length:var(--text-sm)] text-[var(--ink)]"
        >
          <span>
            {recipientAdditions.length === 1
              ? 'Email sent. Add the recipient to this deal.'
              : 'Email sent. Add the recipients to this deal.'}
          </span>
          {recipientHandoffs(projectId, recipientAdditions).flatMap(({ email, links }) =>
            links.map((link) => (
              <Link
                key={`${email}:${link.kind}`}
                className="underline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                href={link.href}
                onClick={() => queueRecipientAddition(projectId, email, link.kind)}
              >
                {link.label}
              </Link>
            )),
          )}
          <Button size="sm" variant="secondary" onClick={() => setRecipientAdditions([])}>
            Not now
          </Button>
        </div>
      ) : null}

      {showReviewNotice ? (
        <div
          role="status"
          className="flex shrink-0 items-center gap-[var(--space-3)] border-b border-[var(--hold-fill)] bg-[var(--hold-tint)] px-[var(--space-4)] py-[var(--space-2)]"
        >
          <Badge tone="hold">Review</Badge>
          <span className="min-w-0 flex-1 truncate font-sans text-[length:var(--text-sm)] text-[var(--ink)]">
            {[
              returnedMine.length > 0
                ? `${returnedMine.length} message${returnedMine.length > 1 ? 's' : ''} returned to you`
                : null,
              heldMine.length > 0
                ? `${heldMine.length} held for review`
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <Button size="sm" variant="secondary" onClick={openReviewNotice}>
            Open
          </Button>
          <button
            type="button"
            aria-label="Dismiss review notice"
            className="rounded px-[var(--space-2)] font-sans text-[length:var(--text-sm)] text-[var(--ink-tertiary)] hover:text-[var(--ink)]"
            onClick={() => setDismissedReviewKey(reviewKey)}
          >
            ✕
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      {/* Folders: Outlook's left column. Held and Blocked appear only while
          they hold something. Below md the column becomes one row. */}
      <nav
        aria-label="Mail folders"
        className="flex shrink-0 flex-col gap-[var(--space-2)] border-b border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-3)] md:w-[200px] md:border-b-0 md:border-r"
      >
        {heldOnly ? null : (
          <Button
            size="sm"
            className="self-start md:self-stretch"
            onClick={(event) => {
              originRef.current = event.currentTarget;
              setView({ kind: 'compose', draftId: newDraftId(), focusTo: true });
            }}
          >
            New message
          </Button>
        )}
        <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
          {visibleFolders.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                aria-current={folder === f.id ? 'true' : undefined}
                className={folderRow(folder === f.id)}
                onClick={() => {
                  setFolder(f.id);
                  setView({ kind: 'empty' });
                }}
              >
                <span className="truncate">{f.label}</span>
                {counts[f.id] > 0 ? (
                  <span className="font-mono text-[length:var(--text-xs)] tabular-nums text-[var(--ink-tertiary)]">
                    {counts[f.id]}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
        {/* The screening line and the Settings pointer show at every width
            (under the folder row on a phone); the pointer only for viewers
            whose Settings list Mail. */}
        <div className="flex flex-col gap-[var(--space-2)] font-sans text-[length:var(--text-xs)] leading-relaxed text-[var(--ink-tertiary)] md:mt-auto md:pt-[var(--space-4)]">
          <p>Every message is screened before it leaves.</p>
          {/* No composer on a deal the viewer is not on: no pointer to its settings. */}
          {mailSettingsListed && !heldOnly ? (
            <p>
              Your mailbox connection and signature are in{' '}
              <Link
                href={MAIL_SETTINGS_HREF}
                className="text-[var(--ink-secondary)] underline underline-offset-2 hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
              >
                Settings › Mail
              </Link>
              .
            </p>
          ) : null}
        </div>
      </nav>

      {/* Message list */}
      <section
        aria-label="Message list"
        // Remembers the row that opens a message, for focus on Back (phone).
        onClickCapture={(event) => {
          const row = (event.target as HTMLElement).closest<HTMLElement>('li button');
          if (row) originRef.current = row;
        }}
        className={
          'min-h-0 flex-1 flex-col border-[var(--stroke)] md:flex md:w-[340px] md:flex-none md:shrink-0 md:border-r ' +
          (paneOpen ? 'hidden' : 'flex')
        }
      >
        <div className="border-b border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-3)]">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search mail"
            aria-label="Search mail"
            className="w-full rounded-[var(--radius-control)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] font-sans text-[length:var(--text-sm)] text-[var(--ink)] placeholder:text-[var(--ink-quiet)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {!loaded ? (
            <p className="px-[var(--space-5)] py-[var(--space-6)] font-sans text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
              Loading…
            </p>
          ) : folder === 'inbox' ? (
            inboxError || loadError ? (
              <div role="alert" className="flex flex-col items-start gap-[var(--space-3)] px-[var(--space-5)] py-[var(--space-6)]">
                <p className="font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                  The inbox could not be loaded.
                </p>
                <Button type="button" variant="secondary" size="sm" onClick={() => setRefreshKey((k) => k + 1)}>
                  Try again
                </Button>
              </div>
            ) : inList.length === 0 ? (
              <div className="flex flex-col gap-[var(--space-2)] px-[var(--space-5)] py-[var(--space-6)]">
                <p className="font-sans text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
                  {search ? 'No messages match the search.' : 'No mail yet.'}
                </p>
                {!search ? (
                  <p className="font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]">
                    Replies to mail sent from this deal land here.
                  </p>
                ) : null}
              </div>
            ) : (
              <ul>
                {inList.map((m) => {
                  const active = view.kind === 'in' && view.id === m.id;
                  return (
                    <li key={m.id}>
                      <button type="button" aria-current={active ? 'true' : undefined} className={listRow(active)} onClick={() => openInbound(m)}>
                        <span
                          aria-hidden="true"
                          className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] font-sans text-[length:var(--text-xs)] font-semibold text-[var(--accent-contrast)]"
                        >
                          {initialsOf(m.from)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-[var(--space-2)]">
                            <span
                              className={
                                'truncate font-sans text-[length:var(--text-sm)] text-[var(--ink)] ' +
                                (m.read ? 'font-medium' : 'font-semibold')
                              }
                            >
                              {m.from}
                            </span>
                            <span className="shrink-0 font-mono text-[length:var(--text-xs)] tabular-nums text-[var(--ink-tertiary)]">
                              {mailTimestamp(m.receivedAt)}
                            </span>
                          </span>
                          <span
                            className={
                              'block truncate font-sans text-[length:var(--text-sm)] text-[var(--ink)] ' +
                              (m.read ? '' : 'font-semibold')
                            }
                          >
                            {m.subject || '(no subject)'}
                          </span>
                          <span className="block truncate font-sans text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                            {m.body.slice(0, 90)}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )
          ) : folder === 'drafts' ? (
            drafts.length === 0 ? (
              <p className="px-[var(--space-5)] py-[var(--space-6)] font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                No drafts. Drafts save automatically while you write.
              </p>
            ) : (
              <ul>
                {drafts.map((d) => (
                  <li key={d.id}>
                    <button
                      type="button"
                      className="w-full border-b border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-3)] text-left hover:bg-[var(--surface-subtle)]"
                      onClick={() =>
                        openCompose(
                          { to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, bodyHtml: d.bodyHtml },
                          d.id,
                        )
                      }
                    >
                      <span className="flex items-baseline justify-between gap-[var(--space-2)]">
                        <span className="truncate font-sans text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
                          {d.subject || '(no subject)'}
                        </span>
                        <span className="shrink-0 font-mono text-[length:var(--text-xs)] tabular-nums text-[var(--ink-tertiary)]">
                          {mailTimestamp(d.updatedAt)}
                        </span>
                      </span>
                      <span className="block truncate font-sans text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                        {d.to || 'No recipients yet'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : loadError ? (
            <p role="alert" className="px-[var(--space-5)] py-[var(--space-6)] font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
              The outbox could not be loaded. Refresh to retry.
            </p>
          ) : outList.length === 0 ? (
            <p className="px-[var(--space-5)] py-[var(--space-6)] font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
              {search ? 'No messages match the search.' : 'Nothing here yet.'}
            </p>
          ) : (
            <ul>
              {outList.map((m) => {
                const active = view.kind === 'out' && view.id === m.id;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      aria-current={active ? 'true' : undefined}
                      className={listRow(active)}
                      onClick={() => setView({ kind: 'out', id: m.id })}
                    >
                      <span
                        aria-hidden="true"
                        className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] font-sans text-[length:var(--text-xs)] font-semibold text-[var(--accent-contrast)]"
                      >
                        {initialsOf(m.to[0] ?? '?')}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-[var(--space-2)]">
                          <span className="truncate font-sans text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
                            {m.to[0]}
                            {m.to.length > 1 ? ` +${m.to.length - 1}` : ''}
                          </span>
                          <span className="shrink-0 font-mono text-[length:var(--text-xs)] tabular-nums text-[var(--ink-tertiary)]">
                            {mailTimestamp(m.createdAt)}
                          </span>
                        </span>
                        <span className="flex items-center gap-[var(--space-2)]">
                          <span className="min-w-0 truncate font-sans text-[length:var(--text-sm)] text-[var(--ink)]">
                            {m.subject}
                          </span>
                          {m.status === 'rejected' ? <Badge tone="negative">Rejected</Badge> : null}
                          {m.status === 'sent' && m.riskBand === 'queued' ? (
                            <Badge tone="hold">Sent · queued for review</Badge>
                          ) : null}
                          {folder === 'held' && overseer && codenameOf(m) ? (
                            // Deal column of the tenant-wide supervisory queue.
                            <span className="shrink-0 rounded-full border border-[var(--stroke)] px-[var(--space-2)] font-sans text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                              {codenameOf(m)}
                            </span>
                          ) : null}
                        </span>
                        <span className="block truncate font-sans text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                          {m.body.slice(0, 90)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* Reading pane / composer */}
      <section
        aria-label="Reading pane"
        className={'min-h-0 min-w-0 flex-1 flex-col md:flex ' + (paneOpen ? 'flex' : 'hidden')}
      >
        {paneOpen ? (
          <div className="shrink-0 border-b border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-2)] md:hidden">
            <Button ref={backRef} size="sm" variant="ghost" onClick={backToList}>
              Back to messages
            </Button>
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
        {view.kind === 'compose' ? (
          <MailComposer
            key={view.draftId}
            dealRef={dealCode}
            dealRefPending={dealCodePending}
            dealRefUnavailable={dealListUnavailable}
            senderEmail={senderEmail}
            seed={view.seed}
            focusToOnOpen={view.focusTo}
            onDraftChange={handleDraftChange(view.draftId)}
            onSent={(status, additions) => {
              dropDraft(view.draftId);
              setRefreshKey((k) => k + 1);
              if (status !== 'sent') return;
              // Merge, never replace: a later send to known addresses
              // must not wipe an earlier prompt nobody has answered yet.
              setRecipientAdditions((prev) => {
                const seen = new Set(prev.map((r) => r.email.trim().toLowerCase()));
                const fresh = (additions ?? []).filter((r) => {
                  const key = r.email.trim().toLowerCase();
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                });
                return fresh.length > 0 ? [...prev, ...fresh] : prev;
              });
              setFolder('sent');
              setView({ kind: 'empty' });
            }}
            onDiscard={() => {
              dropDraft(view.draftId);
              returnFocusRef.current = true;
              setView({ kind: 'empty' });
            }}
          />
        ) : selectedIn ? (
          <article className="flex h-full min-h-0 flex-col">
            <header className="flex flex-col gap-[var(--space-3)] border-b border-[var(--stroke)] px-[var(--space-6)] py-[var(--space-4)]">
              <h2 className="font-sans text-[length:var(--text-xl)] font-medium tracking-tight text-[var(--ink)]">
                {selectedIn.subject || '(no subject)'}
              </h2>
              <div className="flex flex-wrap items-center justify-between gap-[var(--space-3)]">
                <div className="flex items-center gap-[var(--space-3)]">
                  <span
                    aria-hidden="true"
                    className="flex size-9 items-center justify-center rounded-full bg-[var(--accent)] font-sans text-[length:var(--text-xs)] font-semibold text-[var(--accent-contrast)]"
                  >
                    {initialsOf(selectedIn.from)}
                  </span>
                  <div className="flex flex-col">
                    <span className="font-sans text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
                      {selectedIn.from}
                    </span>
                    <span className="font-sans text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                      To {selectedIn.to}
                      {selectedIn.cc.length > 0 ? ` · Cc ${selectedIn.cc.join(', ')}` : ''}
                      {' · '}
                      {formatDateTime(selectedIn.receivedAt)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-[var(--space-2)]">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      openCompose({
                        to: selectedIn.from,
                        subject: threadSubject(selectedIn.subject, 'Re'),
                        bodyHtml: quoteInbound(selectedIn),
                      })
                    }
                  >
                    Reply
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      openCompose({
                        subject: threadSubject(selectedIn.subject, 'Fw'),
                        bodyHtml: quoteInbound(selectedIn),
                      })
                    }
                  >
                    Forward
                  </Button>
                </div>
              </div>
              {attachmentChips(selectedIn.attachments)}
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-[var(--space-6)] py-[var(--space-5)]">
              {messageBody(selectedIn.body, selectedIn.bodyHtml)}
            </div>
          </article>
        ) : selectedOut ? (
          <article className="flex h-full min-h-0 flex-col">
            <header className="flex flex-col gap-[var(--space-3)] border-b border-[var(--stroke)] px-[var(--space-6)] py-[var(--space-4)]">
              <h2 className="font-sans text-[length:var(--text-xl)] font-medium tracking-tight text-[var(--ink)]">
                {selectedOut.subject}
              </h2>
              <div>
                <RecipientBoundaryBadge boundary={selectedOut.recipientBoundary} />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-[var(--space-3)]">
                <div className="flex items-center gap-[var(--space-3)]">
                  <span
                    aria-hidden="true"
                    className="flex size-9 items-center justify-center rounded-full bg-[var(--accent)] font-sans text-[length:var(--text-xs)] font-semibold text-[var(--accent-contrast)]"
                  >
                    {initialsOf(selectedOut.to[0] ?? '?')}
                  </span>
                  <div className="flex flex-col">
                    <span className="font-sans text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
                      To {selectedOut.to.join(', ')}
                    </span>
                    <span className="font-sans text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                      {selectedOut.cc.length > 0 ? `Cc ${selectedOut.cc.join(', ')} · ` : ''}
                      {formatDateTime(selectedOut.createdAt)}
                      {selectedOut.provider === 'noop'
                        ? ' · Simulated send (no provider configured)'
                        : ''}
                    </span>
                  </div>
                </div>
                {selectedOut.status === 'sent' && !heldOnly ? (
                  <div className="flex items-center gap-[var(--space-2)]">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        openCompose({
                          to: selectedOut.to.join(', '),
                          cc: selectedOut.cc.join(', '),
                          subject: threadSubject(selectedOut.subject, 'Re'),
                          bodyHtml: quoteOutbound(selectedOut),
                        })
                      }
                    >
                      Reply
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        openCompose({
                          subject: threadSubject(selectedOut.subject, 'Fw'),
                          bodyHtml: quoteOutbound(selectedOut),
                        })
                      }
                    >
                      Forward
                    </Button>
                  </div>
                ) : null}
              </div>
              {attachmentChips(selectedOut.attachments)}
            </header>
            {/* The screened-message card sits front and center: outcome,
                why-held, decision row, receipt — then the message. */}
            <div className="flex min-h-0 flex-1 flex-col gap-[var(--space-4)] overflow-y-auto px-[var(--space-6)] py-[var(--space-5)]">
              {selectedOut.status === 'sent' && selectedOut.riskBand === 'queued' ? (
                <div
                  role="status"
                  className={statusCard('hold') + ' gap-[var(--space-2)]'}
                >
                  <span className="flex items-center gap-[var(--space-3)]">
                    <Badge tone="hold">Sent · queued for review</Badge>
                    <span className="font-sans text-[length:var(--text-sm)] text-[var(--ink)]">
                      Delivered. Your compliance team reviews it after sending.
                    </span>
                  </span>
                  {selectedOut.reasons.length > 0 ? (
                    <ul className="flex flex-col gap-1">
                      {selectedOut.reasons.map((r) => (
                        <li
                          key={r}
                          className="font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]"
                        >
                          {r}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="font-sans text-[length:var(--text-xs)] leading-relaxed text-[var(--ink-tertiary)]">
                    The sender chose to send despite these risk issues. That
                    decision is in the audit trail.
                  </p>
                </div>
              ) : null}
              {selectedOut.status === 'held' ? (
                <div
                  role="status"
                  className={statusCard('hold') + ' gap-[var(--space-3)]'}
                >
                  <span className="flex items-center gap-[var(--space-3)]">
                    <Badge tone="hold">Held</Badge>
                    <span className="font-sans text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
                      Not delivered. Waiting on supervisory review.
                    </span>
                  </span>
                  {/* Why this was held — every reason the screen raised. */}
                  {selectedOut.reasons.length > 0 ? (
                    <ul className="flex flex-col gap-1">
                      {selectedOut.reasons.map((r) => (
                        <li
                          key={r}
                          className="font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]"
                        >
                          {r}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]">
                      Held for supervisory review. Not delivered.
                    </span>
                  )}
                  {overseer ? null : (
                    <span className="font-sans text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                      A supervisor will review and release or reject this message.
                    </span>
                  )}
                  {reviewNotice ? (
                    <p role="status" className="font-sans text-[length:var(--text-sm)] text-[var(--ink)]">
                      {reviewNotice}
                    </p>
                  ) : null}
                  {/* What the decision leaves behind, receipt voice. */}
                  <div className="flex flex-col gap-1 border-t border-[var(--hold-fill)] pt-[var(--space-2)]">
                    <p className="font-mono text-[length:var(--text-xs)] leading-relaxed text-[var(--ink-tertiary)]">
                      Held {mailTimestamp(selectedOut.createdAt)}
                    </p>
                    <p className="font-sans text-[length:var(--text-xs)] leading-relaxed text-[var(--ink-tertiary)]">
                      Releasing or rejecting it is recorded in the audit trail.
                    </p>
                  </div>
                </div>
              ) : null}
              {selectedOut.status === 'blocked' ? (
                <div
                  role="status"
                  className={statusCard('negative') + ' gap-[var(--space-2)]'}
                >
                  <span className="flex items-center gap-[var(--space-3)]">
                    <Badge tone="negative">Blocked</Badge>
                    <span className="font-sans text-[length:var(--text-sm)] text-[var(--ink)]">
                      {selectedOut.reasons[0] ?? 'Blocked by the communications screen. Never sent.'}
                    </span>
                  </span>
                  {selectedOut.rewrite ? (
                    <p className="font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink)]">
                      {selectedOut.rewrite}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {selectedOut.status === 'rejected' ? (
                <div
                  role="status"
                  className={statusCard('negative') + ' gap-[var(--space-2)]'}
                >
                  <span className="flex items-center gap-[var(--space-3)]">
                    <Badge tone="negative">Rejected</Badge>
                    <span className="font-sans text-[length:var(--text-sm)] text-[var(--ink)]">
                      Returned by supervisory review. Not sent.
                    </span>
                  </span>
                  {selectedOut.reviewNote ? (
                    <p className="font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink)]">
                      {selectedOut.reviewNote}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {/* The decision row — left-aligned, release first; the review
                  note travels with the buttons that submit it. */}
              {selectedOut.status !== 'sent' ? (
                <div className="flex max-w-[640px] flex-col gap-[var(--space-2)]">
                  {selectedOut.status === 'held' && overseer ? (
                    <textarea
                      value={reviewNote}
                      onChange={(e) => setReviewNote(e.target.value)}
                      rows={2}
                      placeholder="Review note (optional)"
                      aria-label="Review note"
                      className="w-full rounded-[var(--radius-control)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] font-sans text-[length:var(--text-sm)] text-[var(--ink)] placeholder:text-[var(--ink-quiet)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                    />
                  ) : null}
                  <div className="flex flex-wrap items-center gap-[var(--space-2)]">
                    {selectedOut.status === 'held' && overseer ? (
                      <>
                        <Button size="sm" disabled={reviewBusy} onClick={() => void review('release')}>
                          Release and send
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={reviewBusy}
                          onClick={() => void review('reject')}
                        >
                          Reject
                        </Button>
                      </>
                    ) : null}
                    {heldOnly ? null : (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          openCompose({
                            to: selectedOut.to.join(', '),
                            cc: selectedOut.cc.join(', '),
                            subject: selectedOut.subject,
                            bodyHtml: selectedOut.bodyHtml ?? escapeHtml(selectedOut.body),
                          })
                        }
                      >
                        Edit and resend
                      </Button>
                    )}
                  </div>
                </div>
              ) : null}
              {messageBody(selectedOut.body, selectedOut.bodyHtml)}
            </div>
          </article>
        ) : (
          <div className="h-full" />
        )}
        </div>
      </section>
      </div>
    </div>
  );
}
