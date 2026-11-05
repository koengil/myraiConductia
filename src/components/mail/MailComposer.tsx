'use client';

import { RecipientReviewDialog } from './RecipientReviewDialog';
import { ExternalSendConfirmDialog } from './ExternalSendConfirmDialog';
import { RecipientRelationshipList } from './RecipientRelationshipList';
import { useWarningOutcomes } from './useWarningOutcomes';
import { useRecipientReview } from './useRecipientReview';
import type { RecipientDecision, RecipientField } from '@/lib/mail/recipientReview';

import * as React from 'react';
import { Bold, Italic, List, ListOrdered, Paperclip, Underline } from 'lucide-react';

import { useSession } from '@/lib/session/store';
import { Badge, Button } from '@/components/atoms';
import { RecipientBoundaryWarning } from './RecipientBoundaryWarning';
import { findScreenHits, type ScreenHit } from '@/lib/compliance/screen';
import {
  LEXICON_CATEGORY_SHORT,
  LEXICON_TIER_SURFACE,
  findLexiconMatches,
  normalizeLexiconText,
  type LexiconMatch,
} from '@/lib/compliance/lexicon';
import { toPlainText, formatBytes } from '@/lib/mail/format';
import { LIFECYCLE_CATEGORIES, type LifecycleCategory } from '@/lib/constants/deals';
import { confidentialSubject, requiresConfidential } from '@/lib/mail/confidential';
import { EmailListInput } from '@/components/people/EmailListInput';
import { Dialog, useRetainedWhileClosing } from '@/components/overlay';
import { onlySenderDomain } from '@/lib/mail/dealRef';
import { DEAL_LIST_UNAVAILABLE_COPY, TRY_AGAIN_COPY } from '@/components/deals/DealsUnavailable';

/**
 * MailComposer — the compose pane of the Outlook-style mail client. Both AI
 * layers of the pre-send service are wired here:
 *
 *   Layer 1, as you type: a debounced POST /api/v1/screen (mode "fast")
 *   flags risky wording inline with the reason and rewrite. Advisory only.
 *
 *   Layer 2, on send: POST /api/v1/outbox runs the full screen server-side:
 *   sent (fields clear) | held (supervisory queue, draft preserved) |
 *   blocked (rewrite shown, draft preserved).
 *
 * Outlook affordances: Cc/Bcc toggles, a REAL formatting toolbar (the body is
 * contentEditable; HTML is sent alongside the screened plain text),
 * attachments (max 5, 3MB total; names are screened too), Discard.
 *
 * Ribbon contract: dispatches SET_COMPLIANCE only; the single mounted
 * ComplianceRibbon renders it. Every send path clears the sending flag.
 */

/**
 * The send's idempotency key (POST /api/v1/outbox clientRequestId): a digest
 * of the exact content plus a per-composer nonce. A retry or double click of
 * the same message reuses it (the server never sends it twice); any edit
 * yields a new key; the nonce rotates after a send so identical text can
 * still be sent again on purpose.
 */
async function clientRequestKey(nonce: string, content: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([nonce, content]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

type FastVerdict = {
  verdict: 'compliant' | 'hold' | 'blocked';
  reasons: string[];
  rewrite?: string;
};

type SentReceipt = {
  id: string;
  status: 'sent' | 'held' | 'blocked';
  reasons: string[];
  rewrite?: string | null;
};

type RiskIssues = {
  cause?: string | null;
  reasons: string[];
  /** The LLM's rewritten BODY — one click sends it. */
  rewrite: string | null;
  /** The rule pack's advisory note — guidance only, never a message body. */
  advice?: string | null;
  heat: number | null;
  /** Binds send-as-is to the exact screen the sender saw. */
  token?: string | null;
};

type SendOptions = {
  recipientApprovalToken?: string;
  recipientApprovalRecipients?: RecipientDecision[];
  /** Sign-offs granted in the same event that triggers the send. */
  ackOverride?: ReadonlySet<string>;
  /** Replace the body — the soft-hold modal's "Use AI version" path. */
  bodyOverride?: { text: string; html: string };
  /** Send despite a reputational-only concern (audited server-side). */
  sendAsIs?: boolean;
  /** The soft-hold token — the server honors the override only for it. */
  overrideToken?: string;
  /** The sender confirmed a send outside the firm (Issue #95). */
  externalConfirmed?: boolean;
};

export type ComposerSeed = {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  bodyHtml?: string;
  /** A reply (#339): the signed token with its In-Reply-To and References, echoed to the outbox unread. */
  replyToken?: string;
};

export type ComposerFields = {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  bodyHtml: string;
};

type PendingAttachment = {
  name: string;
  type: string;
  bytes: number;
  contentBase64: string;
};

export type MailComposerProps = {
  /** Opened from the New message button: move focus to the To field on open. */
  focusToOnOpen?: boolean;
  /** As-you-type screen debounce; tests pass 0. */
  screenDebounceMs?: number;
  /**
   * The deal's canonical code, resolved by the caller through the deal
   * listing (useCanonicalDealCode), never the raw URL segment. Sent trimmed
   * as dealId so every message is born tagged to its deal.
   *
   * UI guard only. The outbox route still sends untagged mail without
   * recipient review (handoff E24). So with no code, or a code the deal read
   * answers 404 for, Send refuses any recipient outside the sender's own
   * domain.
   */
  dealRef?: string;
  /** The caller is still resolving the deal code: Send waits, no reason shown. */
  dealRefPending?: boolean;
  /** The signed-in sender's email (GET /api/v1/me): same-domain mail needs no deal. */
  senderEmail?: string | null;
  /**
   * The deal listing failed, so no code could be resolved: the composer says
   * the list failed (with its retry) instead of "could not match", and an
   * outside send stays blocked.
   */
  dealRefUnavailable?: { retry: () => void } | null;
  /** Prefill (draft reopen, Reply, Forward, Edit and resend). */
  seed?: ComposerSeed;
  /** A message reached the outbox (any status). */
  onSent?: (status: SentReceipt['status'], additions?: RecipientDecision[]) => void;
  /** Debounced field snapshot for draft auto-save. */
  onDraftChange?: (fields: ComposerFields) => void;
  /** Discard clicked — the owner closes the pane and drops the draft. */
  onDiscard?: () => void;
};

const MAX_FILES = 5;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;

const VERDICT_TONE = { compliant: 'positive', hold: 'hold', blocked: 'negative' } as const;
const VERDICT_LABEL = { compliant: 'Clear', hold: 'Review', blocked: 'Blocked' } as const;

/* Field label — gray 12px, sentence case (kit §06). */
const FIELD_LABEL_CLASS =
  'w-16 shrink-0 font-sans text-[length:var(--text-sm)] font-medium text-[var(--ink-secondary)]';

const FIELD_CLASS =
  'w-full rounded-[var(--radius-control)] border border-transparent bg-[var(--surface-subtle)] ' +
  'px-[var(--space-3)] py-[var(--space-2)] font-sans text-[length:var(--text-sm)] text-[var(--ink)] ' +
  'placeholder:text-[var(--ink-quiet)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]';

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

/**
 * Word-level diff (LCS) for the soft-hold redraft: returns the REWRITE's
 * tokens, marking the ones not present in the original so the modal can
 * highlight exactly what the AI changed (Storm: "changes highlighted").
 */
function diffWords(from: string, to: string): Array<{ text: string; added: boolean }> {
  const a = from.split(/\s+/).filter(Boolean);
  const b = to.split(/\s+/).filter(Boolean);
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: Array<{ text: string; added: boolean }> = [];
  let i = 0;
  let j = 0;
  while (j < m) {
    if (i < n && a[i] === b[j]) {
      out.push({ text: b[j], added: false });
      i++;
      j++;
    } else if (i < n && lcs[i + 1][j] >= lcs[i][j + 1]) {
      i++; // word removed from the original — not rendered on the rewrite side
    } else {
      out.push({ text: b[j], added: true });
      j++;
    }
  }
  return out;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Why Send is off when no deal matches. */
export const NO_DEAL_MATCH_REASON =
  'Conductia could not match this message to a deal, so it cannot check the recipients. Open the deal and try again.';

export function MailComposer({
  screenDebounceMs = 600,
  dealRef: rawDealRef,
  dealRefPending = false,
  senderEmail,
  dealRefUnavailable = null,
  seed,
  focusToOnOpen = false,
  onSent,
  onDraftChange,
  onDiscard,
}: MailComposerProps) {
  const { dispatch } = useSession();
  // The canonical code with no stray whitespace: " SUM-2026-014" would
  // resolve to no deal on the server and skip recipient review (E24).
  const dealRef = rawDealRef?.trim() || undefined;
  // Anonymous count of drafts sent or given up after a warning (Storm Q5 = B).
  const { noteWarning, settle: settleWarnings, clear: clearWarnings } = useWarningOutcomes();

  const [to, setTo] = React.useState(seed?.to ?? '');
  const [cc, setCc] = React.useState(seed?.cc ?? '');
  const [bcc, setBcc] = React.useState(seed?.bcc ?? '');
  const [showCc, setShowCc] = React.useState(Boolean(seed?.cc));
  const [showBcc, setShowBcc] = React.useState(Boolean(seed?.bcc));
  const [subject, setSubject] = React.useState(seed?.subject ?? '');
  // Fixed at open: a reply stays in the thread it was started from.
  const [threading] = React.useState(() =>
    seed?.replyToken ? { replyToken: seed.replyToken } : null,
  );
  const [policy, setPolicy] = React.useState<{
    ref: string | undefined;
    state: 'ready' | 'error';
    required: boolean;
    untagged?: boolean;
  } | null>(null);
  // Reset during the context transition so A -> B -> A cannot reuse A's
  // previous result for even one render while a fresh lookup is pending.
  const [policyContext, setPolicyContext] = React.useState(dealRef);
  if (policyContext !== dealRef) {
    setPolicyContext(dealRef);
    setPolicy(null);
  }
  const [policyRetry, setPolicyRetry] = React.useState(0);
  React.useEffect(() => {
    if (!dealRef) return;
    const controller = new AbortController();
    let current = true;
    void (async () => {
      try {
        const res = await fetch(`/api/v1/deals/${encodeURIComponent(dealRef)}`, { signal: controller.signal });
        if (res.status === 404) {
          if (current) setPolicy({ ref: dealRef, state: 'ready', required: false, untagged: true });
          return;
        }
        if (!res.ok) throw new Error('Deal lookup failed');
        const data = await res.json();
        const category: unknown = data?.deal?.lifecycleCategory;
        if (!LIFECYCLE_CATEGORIES.includes(category as LifecycleCategory)) throw new Error('Invalid lifecycle');
        if (current) setPolicy({ ref: dealRef, state: 'ready', required: requiresConfidential(category as LifecycleCategory) });
      } catch {
        if (current) setPolicy({ ref: dealRef, state: 'error', required: false });
      }
    })();
    return () => { current = false; controller.abort(); };
  }, [dealRef, policyRetry]);
  const activePolicy = policy?.ref === dealRef ? policy : null;
  const policyReady = !dealRef || activePolicy?.state === 'ready';
  // The preview is a courtesy; the server reads the lifecycle itself and marks
  // the subject on every send. So a failed lookup must not take the send path
  // away: only the brief pending state holds the button.
  const policySettled = !dealRef || activePolicy !== null;
  const effectiveSubject = confidentialSubject(subject.trim(), Boolean(dealRef && activePolicy?.required));
  // The rich body lives in the contentEditable DOM; this mirror drives the
  // fast screen + draft auto-save without re-rendering the editor.
  const [bodyHtml, setBodyHtml] = React.useState(seed?.bodyHtml ?? '');
  const [attachments, setAttachments] = React.useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [fast, setFast] = React.useState<FastVerdict | null>(null);
  const [receipt, setReceipt] = React.useState<SentReceipt | null>(null);
  const [errorNotice, setErrorNotice] = React.useState<string | null>(null);
  // Layer 1 overrides (#155): terms the sender has signed off on, keyed by
  // the hit's normalized text. An override is a sender decision, recorded for
  // Layer 2 (#156) — never a compliance pre-review.
  const [acknowledged, setAcknowledged] = React.useState<ReadonlySet<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  // A reputational-only concern returned to the SENDER (#158, decision 2):
  // nothing was stored or sent; the sender decides. Heat is ephemeral by
  // design — displayed here, never persisted anywhere.
  const [riskIssues, setRiskIssues] = React.useState<RiskIssues | null>(null);

  const editorRef = React.useRef<HTMLDivElement | null>(null);
  const sectionRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (focusToOnOpen) sectionRef.current?.querySelector<HTMLElement>('[aria-label="To"]')?.focus();
    // Once, when the composer opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const sendRef = React.useRef<HTMLButtonElement | null>(null);
  // Where focus goes once a review dialog has closed. Send was
  // disabled while screening, so the dialog's own restore would land on the
  // page body.
  const [focusAfterClose, setFocusAfterClose] = React.useState<'send' | 'to' | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const activeRef = React.useRef(true);
  const sendNonceRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  // Seed the editor once (contentEditable is uncontrolled after mount).
  React.useEffect(() => {
    if (editorRef.current && seed?.bodyHtml) {
      editorRef.current.innerHTML = seed.bodyHtml;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bodyText = React.useMemo(() => toPlainText(bodyHtml), [bodyHtml]);

  // Every screened source, built ONCE — the rule chips, the lexicon signals,
  // and the debounced fast screen must all read the same content, or the
  // vocabularies silently diverge when a field is added to one list only.
  const screenSources = React.useMemo(
    () => [effectiveSubject, bodyText, ...attachments.map((a) => a.name)],
    [effectiveSubject, bodyText, attachments],
  );

  // Layer 1 hits, computed LOCALLY from the same patterns as the send gate —
  // instant (no debounce), addressable per term. Subject and attachment names
  // are screened too, so their hits surface as chips (no underline target).
  // Each field is screened SEPARATELY: joining them first lets \s+ in the
  // patterns match across field boundaries, minting phantom terms (e.g.
  // "we\n\nguarantee" from a subject ending "we" and a body starting
  // "Guarantee…") that exist in no field and can never be underlined.
  const hits = React.useMemo(() => {
    const seen = new Set<string>();
    const merged: ScreenHit[] = [];
    for (const source of screenSources) {
      for (const hit of findScreenHits(source)) {
        if (seen.has(hit.key)) continue;
        seen.add(hit.key);
        merged.push(hit);
      }
    }
    return merged;
  }, [screenSources]);
  const pendingHits = React.useMemo(
    () => hits.filter((h) => !acknowledged.has(h.key)),
    [hits, acknowledged],
  );

  // Lexicon Tier-1 signals (#163 slice 2) — the vocabulary the firm watches,
  // surfaced spell-check style: a quiet underline and a listing, nothing
  // more. ADVISORY BY DOCTRINE ("this is not a blocking list"): no sign-off,
  // no chip, never a gate on Send.
  const lexiconSignals = React.useMemo(() => {
    const seen = new Set<string>();
    const kept: LexiconMatch[] = [];
    // Body first: on a phrase found in several fields, the BODY's wording
    // wins — it is the only field the underline can reach, and the strip
    // must cite text that is actually in the message body when it is there.
    const bodyFirst = [bodyText, effectiveSubject, ...attachments.map((a) => a.name)];
    for (const source of bodyFirst) {
      // Suppression is PER FIELD and containment-only: skip a lexicon match
      // exactly when this same field's rule pack already chips a term that
      // covers it ("guaranteed" inside a chipped "guaranteed return") —
      // double-marking one stretch of text would read as two problems. A
      // rule hit elsewhere (another field) or a mere overlap the other way
      // around ("$200M" inside "make the model support $200M") suppresses
      // nothing: those are genuinely distinct concerns.
      const chipped = findScreenHits(source).map((h) => h.term.toLowerCase());
      const inField = findLexiconMatches(source).filter(
        (m) =>
          LEXICON_TIER_SURFACE[m.tier].sender &&
          !chipped.some((term) => term.includes(m.match.toLowerCase())),
      );
      // Nested library entries ("guaranteed" inside "guaranteed allocation")
      // describe ONE occurrence — keep the most specific match, but only
      // WITHIN this field: a longer subject match must never discard the
      // body's own shorter occurrence, or the body loses its underline.
      const bySpecificity = [...inField].sort((a, b) => b.match.length - a.match.length);
      const fieldKept: LexiconMatch[] = [];
      for (const m of bySpecificity) {
        if (fieldKept.some((k) => k.match.toLowerCase().includes(m.match.toLowerCase()))) continue;
        fieldKept.push(m);
      }
      for (const m of fieldKept) {
        if (seen.has(m.phrase)) continue;
        seen.add(m.phrase);
        kept.push(m);
      }
    }
    return kept.sort((a, b) => a.tier - b.tier || a.phrase.localeCompare(b.phrase));
  }, [bodyText, effectiveSubject, attachments]);

  // Underline the flagged terms inside the contentEditable body via the CSS
  // Custom Highlight API — no DOM mutation, so the caret never jumps.
  // Progressive enhancement: silently absent where unsupported (jsdom).
  React.useEffect(() => {
    if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;
    const editor = editorRef.current;
    if (!editor) return;

    // wordBounded: the LEXICON matchers found their terms behind (?<!\w)…(?!\w)
    // boundaries, so re-finding them mid-word ("text me" inside "context
    // menu") would paint a false underline. The rule-pack terms are NOT
    // boundary-anchored ("guaranteed return" is meant to hit "guaranteed
    // returns"), so their underline must stay a plain substring search.
    const rangesFor = (terms: string[], wordBounded = false): Range[] => {
      const ranges: Range[] = [];
      if (terms.length === 0) return ranges;
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      let full = '';
      const offsets: number[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        nodes.push(n as Text);
        offsets.push(full.length);
        full += (n as Text).data;
      }
      // Normalize EXACTLY like the lexicon matcher (one shared function,
      // documented 1:1 length-preserving so the offset math stays aligned):
      // NBSP -> space, smart quotes -> straight.
      const lower = normalizeLexiconText(full).toLowerCase();
      // toLowerCase can change string LENGTH for rare code points (Turkish
      // İ and friends); the offset math below would then misplace ranges or
      // throw. Skip underlining in that case — the chips carry the info.
      if (lower.length !== full.length) return ranges;
      const locate = (globalOffset: number): { node: Text; offset: number } | null => {
        for (let i = nodes.length - 1; i >= 0; i--) {
          if (globalOffset >= offsets[i]) {
            return { node: nodes[i], offset: globalOffset - offsets[i] };
          }
        }
        return null;
      };
      const isWordChar = (ch: string | undefined) => ch !== undefined && /\w/.test(ch);
      for (const term of terms) {
        const needle = term.toLowerCase();
        let from = 0;
        for (let at = lower.indexOf(needle, from); at !== -1; at = lower.indexOf(needle, from)) {
          if (wordBounded && (isWordChar(lower[at - 1]) || isWordChar(lower[at + needle.length]))) {
            from = at + 1;
            continue;
          }
          const start = locate(at);
          const end = locate(at + needle.length - 1);
          if (start && end) {
            try {
              const range = new Range();
              range.setStart(start.node, start.offset);
              range.setEnd(end.node, end.offset + 1);
              ranges.push(range);
            } catch {
              // A missing underline beats a crashed composer.
            }
          }
          from = at + needle.length;
        }
      }
      return ranges;
    };

    const registry = CSS.highlights as unknown as Map<string, unknown>;
    const HighlightCtor = (window as unknown as { Highlight: new (...r: Range[]) => unknown })
      .Highlight;
    registry.set(
      'l1-pending',
      new HighlightCtor(...rangesFor(pendingHits.map((h) => h.term))),
    );
    registry.set(
      'l1-acked',
      new HighlightCtor(
        ...rangesFor(hits.filter((h) => acknowledged.has(h.key)).map((h) => h.term)),
      ),
    );
    registry.set(
      'lexicon-advisory',
      new HighlightCtor(...rangesFor(lexiconSignals.map((m) => m.match), true)),
    );
    return () => {
      registry.delete('l1-pending');
      registry.delete('l1-acked');
      registry.delete('lexicon-advisory');
    };
  }, [bodyHtml, hits, pendingHits, acknowledged, lexiconSignals]);

  const acknowledge = (key: string) => {
    // Touching a chip retires an armed Send attempt: the sender is deciding
    // per term again, not confirming a batch.
    setConfirmOpen(false);
    setRiskIssues(null);
    setAcknowledged((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Layer 1 — the as-you-type fast screen (subject + body + filenames).
  React.useEffect(() => {
    const text = screenSources.join('\n\n').trim();
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      if (!text) {
        if (activeRef.current) setFast(null);
        return;
      }
      try {
        const res = await fetch('/api/v1/screen', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, mode: 'fast' }),
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as FastVerdict;
        if (activeRef.current) setFast(data);
      } catch {
        // Advisory layer only.
      }
    }, screenDebounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [screenSources, screenDebounceMs]);

  // Draft auto-save snapshot, debounced on the same cadence class.
  React.useEffect(() => {
    if (!onDraftChange) return;
    const timer = setTimeout(() => {
      onDraftChange({ to, cc, bcc, subject, bodyHtml });
    }, 800);
    return () => clearTimeout(timer);
  }, [to, cc, bcc, subject, bodyHtml, onDraftChange]);

  const exec = (command: string) => {
    editorRef.current?.focus();
    document.execCommand(command);
    if (editorRef.current) setBodyHtml(editorRef.current.innerHTML);
  };

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setAttachError(null);
    const next = [...attachments];
    for (const file of Array.from(files)) {
      if (next.length >= MAX_FILES) {
        setAttachError(`At most ${MAX_FILES} attachments.`);
        break;
      }
      if (next.reduce((s, a) => s + a.bytes, 0) + file.size > MAX_TOTAL_BYTES) {
        setAttachError('Attachments are limited to 3MB in total.');
        break;
      }
      try {
        next.push({
          name: file.name,
          type: file.type,
          bytes: file.size,
          contentBase64: await fileToBase64(file),
        });
      } catch {
        setAttachError(`Could not read ${file.name}.`);
      }
    }
    setAttachments(next);
    if (fileRef.current) fileRef.current.value = '';
  };

  const parseList = (value: string) =>
    value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

  const draftKey = JSON.stringify([dealRef,to,cc,bcc,effectiveSubject,bodyHtml,attachments]);
  const [recipientApproval,setRecipientApproval] = React.useState<{token:string;recipients:RecipientDecision[];snapshot:string}|null>(null);
  const [recipientChallenge,setRecipientChallenge] = React.useState<{token:string;recipients:RecipientDecision[];snapshot:string;options?:SendOptions}|null>(null);
  const [recipientContext,setRecipientContext] = React.useState(draftKey);
  // Send friction (Issue #95): the firm's confirm step for a send outside it,
  // kept for this exact draft so a later send-as-is does not ask again.
  const [externalChallenge,setExternalChallenge] = React.useState<{recipients:string[];snapshot:string;options?:SendOptions}|null>(null);
  const [externalConfirmedFor,setExternalConfirmedFor] = React.useState<string|null>(null);
  if (recipientContext !== draftKey) {
    setRecipientContext(draftKey);setRecipientApproval(null);setRecipientChallenge(null);setExternalChallenge(null);
  }
  const recipientPreview = useRecipientReview(dealRef,{to:parseList(to),cc:parseList(cc),bcc:parseList(bcc)});
  const removeRecipient = (field:RecipientField,email:string) => {
    const update = (value:string) => parseList(value).filter(v=>v.trim().toLowerCase()!==email.toLowerCase()).join(', ');
    if(field==='to')setTo(update);else if(field==='cc')setCc(update);else setBcc(update);
    setRecipientChallenge(null);setRecipientApproval(null);
  };

  // Deal guard: every UI send carries a deal reference. UI guard only. The
  // outbox route still sends untagged mail without recipient review (handoff
  // E24). A message the composer cannot match to a deal (no code, or the deal
  // read answered 404) goes only to the sender's own domain; anything else
  // waits until the deal is open.
  const allRecipients = [...parseList(to), ...parseList(cc), ...parseList(bcc)];
  const noDealMatch = !dealRefPending && (!dealRef || activePolicy?.untagged === true);
  const dealGuardBlocks = noDealMatch && !onlySenderDomain(allRecipients, senderEmail);

  const canSend =
    policySettled && !dealRefPending && !dealGuardBlocks && effectiveSubject.length <= 1_000 &&
    parseList(to).length > 0 && subject.trim().length > 0 && bodyText.trim().length > 0;

  // ackOverride: sign-offs granted in the same event that triggers the send
  // (the confirmation modal) — React state has not committed yet there, so the
  // fresh set must travel by argument or the POST reads the stale closure.
  const doSend = React.useCallback(async (opts?: SendOptions) => {
    const acked = opts?.ackOverride ?? acknowledged;
    const sendText = opts?.bodyOverride?.text ?? bodyText;
    const sendHtml = opts?.bodyOverride?.html ?? bodyHtml;
    const recipients = parseList(to);
    if (sending || !policySettled || dealRefPending || dealGuardBlocks || effectiveSubject.length > 1_000 || recipients.length === 0 || !subject.trim() || !sendText.trim()) return;

    setSending(true);
    setReceipt(null);
    setRiskIssues(null);
    setErrorNotice(null);
    dispatch({ type: 'SET_COMPLIANCE', status: 'scanning' });

    try {
      sendNonceRef.current ??= crypto.randomUUID();
      const clientRequestId = await clientRequestKey(sendNonceRef.current, [
        dealRef ?? null, recipients, parseList(cc), parseList(bcc), effectiveSubject, sendText, sendHtml,
        attachments.map((a) => [a.name, a.type, a.contentBase64]),
      ]);
      const res = await fetch('/api/v1/outbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientRequestId,
          to: recipients,
          recipientApprovalToken: opts?.recipientApprovalToken ?? (recipientApproval?.snapshot === draftKey ? recipientApproval.token : undefined),
          cc: parseList(cc),
          bcc: parseList(bcc),
          ...(dealRef ? { dealId: dealRef } : {}),
          ...(threading ?? {}),
          // Sender sign-offs (#156): the server validates these against the
          // real Layer 1 hits, records them in the compliance audit, and
          // tells the AI layer not to re-flag what the sender already saw.
          ...(hits.some((h) => acked.has(h.key))
            ? {
                preApproved: hits
                  .filter((h) => acked.has(h.key))
                  .map((h) => h.key),
              }
            : {}),
          ...(opts?.sendAsIs ? { sendAsIs: true, overrideToken: opts.overrideToken } : {}),
          ...(opts?.externalConfirmed || externalConfirmedFor === draftKey ? { externalConfirmed: true } : {}),
          subject: effectiveSubject,
          body: sendText,
          html: sendHtml || undefined,
          attachments: attachments.map((a) => ({
            name: a.name,
            contentBase64: a.contentBase64,
            type: a.type || undefined,
          })),
        }),
      });
      if (!activeRef.current) return;

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string; externalConfirmationRequired?: {recipients:string[]} }
          | null;
        // Send friction (D105) answers 409: ask the sender, nothing was screened or recorded.
        if (res.status === 409 && data?.externalConfirmationRequired) {
          dispatch({type:'SET_COMPLIANCE',status:'idle'});
          setRecipientChallenge(null);
          setExternalChallenge({recipients:data.externalConfirmationRequired.recipients,snapshot:draftKey,options:opts});
          return;
        }
        dispatch({ type: 'SET_COMPLIANCE', status: 'idle' });
        // The review dialog covers the notice; close it so the banker can read why.
        setRecipientChallenge(null);
        setErrorNotice(data?.error ?? 'The message could not be handed to the email provider.');
        return;
      }

      const payload = (await res.json()) as {
        message?: SentReceipt;
        recipientReviewRequired?: {token:string;recipients:RecipientDecision[]};
        riskIssues?: RiskIssues;
      };
      if (payload.recipientReviewRequired) {
        dispatch({type:'SET_COMPLIANCE',status:'idle'});
        noteWarning('recipient_review');
        setRecipientChallenge({...payload.recipientReviewRequired,snapshot:JSON.stringify([dealRef,to,cc,bcc,effectiveSubject,sendHtml,attachments]),options:opts});
        return;
      }
      setRecipientChallenge(null);
      setExternalChallenge(null);
      // Risk Patcher (#192): nothing stored, nothing sent — the decision
      // comes back to the sender, whatever the cause (MNPI included). The
      // ribbon goes idle: asserting 'hold' for a flow that holds nothing
      // would be the instrument lying.
      if (payload.riskIssues) {
        dispatch({ type: 'SET_COMPLIANCE', status: 'idle' });
        noteWarning('risk_issues');
        setRiskIssues(payload.riskIssues);
        if (opts?.sendAsIs) {
          // The sender's explicit choice was not honored (stale token after
          // an edit, response drift) — say so instead of looping silently.
          setErrorNotice('Send as-is was not honored. The message changed since that review. Decide again below.');
        } else if (opts?.bodyOverride) {
          // The AI fix covers the BODY only; risk that lives in the subject
          // or an attachment name comes straight back. Name the way out.
          setErrorNotice('The remaining risk issues are outside the message body (subject or attachment names). Edit those and send again.');
        }
        return;
      }
      if (!payload.message) {
        dispatch({ type: 'SET_COMPLIANCE', status: 'idle' });
        setErrorNotice('Unexpected response from the send path.');
        return;
      }
      const message = payload.message;
      // Only an email that went out is counted (D80). Settle before onSent:
      // the owner may close this composer right away. A held or blocked draft
      // stays open with its warnings, so a later successful send still counts.
      if (message.status === 'sent') settleWarnings();
      setReceipt(message);
      onSent?.(message.status, (opts?.recipientApprovalRecipients ?? recipientApproval?.recipients ?? []).filter(r=>r.requiresConfirmation&&r.reason==='not_on_deal'));

      if (message.status === 'sent') {
        sendNonceRef.current = null;
        dispatch({ type: 'SET_COMPLIANCE', status: 'clear' });
        setTo('');
        setCc('');
        setBcc('');
        setSubject('');
        setBodyHtml('');
        setAttachments([]);
        setFast(null);
        // Sign-offs are per message: the next draft composed in this pane
        // must re-ask for the same terms, not inherit a sent message's acks.
        setAcknowledged(new Set());
        if (editorRef.current) editorRef.current.innerHTML = '';
      } else if (message.status === 'held') {
        dispatch({ type: 'SET_COMPLIANCE', status: 'hold' });
      } else {
        dispatch({ type: 'SET_COMPLIANCE', status: 'blocked' });
      }
    } catch (err) {
      console.error('[MailComposer] send failed', err);
      if (!activeRef.current) return;
      dispatch({ type: 'SET_COMPLIANCE', status: 'idle' });
      setErrorNotice('The message could not be sent. Try again.');
    } finally {
      if (activeRef.current) setSending(false);
    }
  }, [to, cc, bcc, subject, effectiveSubject, policySettled, dealRefPending, dealGuardBlocks, bodyText, bodyHtml, attachments, sending, dispatch, onSent, dealRef, hits, acknowledged, draftKey, recipientApproval, externalConfirmedFor, noteWarning, settleWarnings, threading]);


  // One action suffices (Storm): terms already signed off via their chip
  // send straight through; the confirmation modal exists ONLY for hits the
  // sender has not looked at yet.
  const attemptSend = React.useCallback(() => {
    if (pendingHits.length > 0) {
      setConfirmOpen(true);
      return;
    }
    void doSend();
  }, [pendingHits, doSend]);

  const confirmAndSend = () => {
    const next = new Set(acknowledged);
    for (const h of pendingHits) next.add(h.key);
    setAcknowledged(next);
    setConfirmOpen(false);
    // Pass the fresh set: the state update above has not committed yet, and
    // the modal's sign-offs must ride in THIS send's preApproved.
    void doSend({ ackOverride: next });
  };

  // The risk dialog keeps its record through the exit motion.
  const shownRisk = useRetainedWhileClosing(riskIssues);
  const rewriteDiff = React.useMemo(
    () => (shownRisk?.rewrite ? diffWords(bodyText, shownRisk.rewrite) : []),
    [bodyText, shownRisk],
  );

  const dismissRiskIssues = () => {
    setRiskIssues(null);
    // The global ribbon must not keep asserting 'hold' for a message the
    // server explicitly did not store or send.
    dispatch({ type: 'SET_COMPLIANCE', status: 'idle' });
  };

  const useAiVersionAndSend = () => {
    if (!riskIssues?.rewrite) return;
    const text = riskIssues.rewrite;
    const htmlBody = escapeHtmlText(text);
    setBodyHtml(htmlBody);
    if (editorRef.current) editorRef.current.innerHTML = htmlBody;
    setRiskIssues(null);
    void doSend({ bodyOverride: { text, html: htmlBody } });
  };

  const sendAsIs = () => {
    // No token, no silent loop: the server ignores an unbound flag and would
    // reopen this dialog with zero feedback. Fail loudly instead.
    if (!riskIssues?.token) {
      setRiskIssues(null);
      setErrorNotice('Send as-is could not be honored for this screen. Send again to get a fresh review.');
      return;
    }
    const token = riskIssues.token;
    setRiskIssues(null);
    void doSend({ sendAsIs: true, overrideToken: token });
  };

  // The dialog cannot outlive its purpose: visibility is DERIVED — it shows
  // only while a Send attempt is armed AND pending hits remain, so it can
  // never offer "Acknowledge 0 and send". The armed flag itself is retired in
  // the event handlers (editing or touching a chip means "back to editing"),
  // never inside an effect.
  const confirmDialogOpen = confirmOpen && pendingHits.length > 0;
  // Each dialog keeps its record through the exit motion.
  const shownHits = useRetainedWhileClosing(confirmDialogOpen ? pendingHits : null) ?? [];
  const recipientDialogOpen = recipientChallenge?.snapshot === draftKey;
  const shownRecipientChallenge = useRetainedWhileClosing(recipientDialogOpen ? recipientChallenge : null);
  const externalDialogOpen = externalChallenge?.snapshot === draftKey;
  const shownExternalChallenge = useRetainedWhileClosing(externalDialogOpen ? externalChallenge : null);
  React.useEffect(() => {
    if (!focusAfterClose || recipientDialogOpen) return;
    // After the dialog's exit has released focus (its cleanup runs first).
    const timer = setTimeout(() => {
      const target =
        focusAfterClose === 'to'
          ? sectionRef.current?.querySelector<HTMLElement>('[aria-label="To"]')
          : sendRef.current;
      target?.focus();
      setFocusAfterClose(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [focusAfterClose, recipientDialogOpen]);

  const toolbarButton =
    'inline-flex h-7 min-w-7 items-center justify-center rounded-[var(--radius-control)] px-1.5 font-sans text-[length:var(--text-sm)] ' +
    'text-[var(--ink-secondary)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)]';

  return (
    <section ref={sectionRef} aria-label="Compose email" className="relative flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-[var(--space-3)] border-b border-[var(--stroke)] px-[var(--space-5)] py-[var(--space-3)]">
        <span className="font-sans text-[length:var(--text-base)] font-medium text-[var(--ink)]">
          New message
        </span>
        <div className="flex items-center gap-[var(--space-2)]">
          {/* The tooltip lives on the wrapper: the Button atom sets
              disabled:pointer-events-none, so a title on the disabled button
              itself never fires. */}
          <span
            title={
              canSend
                ? undefined
                : dealGuardBlocks
                  ? dealRefUnavailable
                    ? DEAL_LIST_UNAVAILABLE_COPY
                    : NO_DEAL_MATCH_REASON
                  : 'Add a recipient, a subject and a message body to send.'
            }
          >
            <Button ref={sendRef} size="sm" onClick={attemptSend} disabled={sending || !canSend}>
              {sending ? 'Screening…' : 'Send'}
            </Button>
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              // A discarded draft's warnings are forgotten, so a reused composer never reports them (D80).
              clearWarnings();
              onDiscard?.();
            }}
          >
            Discard
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-[var(--space-2)] overflow-y-auto px-[var(--space-5)] py-[var(--space-3)]">
        <div className="flex items-center gap-[var(--space-2)]">
          <label className="flex flex-1 items-center gap-[var(--space-2)]">
            <span className={FIELD_LABEL_CLASS}>
              To
            </span>
            <EmailListInput
              value={to}
              onChange={setTo}
              dealId={dealRef}
              placeholder="name@company.com, name@company.com"
              aria-label="To"
              className={FIELD_CLASS}
            />
          </label>
          {!showCc ? (
            <button type="button" className={toolbarButton} onClick={() => setShowCc(true)}>
              Cc
            </button>
          ) : null}
          {!showBcc ? (
            <button type="button" className={toolbarButton} onClick={() => setShowBcc(true)}>
              Bcc
            </button>
          ) : null}
        </div>

        {showCc ? (
          <label className="flex items-center gap-[var(--space-2)]">
            <span className={FIELD_LABEL_CLASS}>
              Cc
            </span>
            <EmailListInput
              value={cc}
              onChange={setCc}
              dealId={dealRef}
              aria-label="Cc"
              className={FIELD_CLASS}
            />
          </label>
        ) : null}
        {showBcc ? (
          <label className="flex items-center gap-[var(--space-2)]">
            <span className={FIELD_LABEL_CLASS}>
              Bcc
            </span>
            <input
              type="text"
              value={bcc}
              onChange={(e) => setBcc(e.target.value)}
              className={FIELD_CLASS}
            />
          </label>
        ) : null}

        {recipientPreview.status === 'ready' ? <RecipientRelationshipList recipients={recipientPreview.recipients} onRemove={removeRecipient}/> : null}
        {recipientPreview.status === 'loading' || recipientPreview.status === 'error' ? (
          <div role="status" className="font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            {recipientPreview.status === 'loading' ? 'Checking recipient relationships.' : 'Recipient relationships unavailable. Sending will check again.'}
            {recipientPreview.status === 'error' ? <Button size="sm" variant="secondary" onClick={recipientPreview.retry}>Retry recipient check</Button> : null}
          </div>
        ) : null}
        <RecipientBoundaryWarning recipients={[...parseList(to), ...parseList(cc), ...parseList(bcc)]} />
        <label className="flex items-center gap-[var(--space-2)]">
          <span className={FIELD_LABEL_CLASS}>
            Subject
          </span>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className={FIELD_CLASS}
          />
        </label>

        <div className="text-sm text-[var(--ink-secondary)]" aria-live="polite">
          {!policyReady ? (
            activePolicy?.state === 'error' ? (
              <div role="alert" className="flex items-center gap-2">
                <span>The Confidential label could not be previewed. It is applied automatically on send when this deal requires it.</span>
                <Button variant="secondary" onClick={() => { setPolicy(null); setPolicyRetry((value) => value + 1); }}>
                  {TRY_AGAIN_COPY}
                </Button>
              </div>
            ) : <p>Checking email confidentiality…</p>
          ) : (
            <>
              {dealGuardBlocks && allRecipients.length > 0 && dealRefUnavailable ? (
                <div role="alert" className="flex flex-wrap items-center gap-2">
                  <span>{DEAL_LIST_UNAVAILABLE_COPY}</span>
                  <Button size="sm" variant="secondary" onClick={dealRefUnavailable.retry}>
                    {TRY_AGAIN_COPY}
                  </Button>
                </div>
              ) : dealGuardBlocks && allRecipients.length > 0 ? (
                <p role="alert">{NO_DEAL_MATCH_REASON}</p>
              ) : activePolicy?.untagged && dealRef ? (
                <p>This email is not linked to a saved deal.</p>
              ) : null}
              <p aria-label="Email subject preview" className="break-words">{effectiveSubject || 'Subject preview'}</p>
              {effectiveSubject.length > 1_000 ? <p role="alert">Shorten the subject to 1,000 characters including the Confidential label.</p> : null}
            </>
          )}
        </div>

        {/* Formatting toolbar — real: commands act on the contentEditable body
            and the resulting HTML is sent alongside the screened plain text. */}
        <div
          role="toolbar"
          aria-label="Formatting"
          className="flex items-center gap-1 border-y border-[var(--stroke)] py-1"
        >
          <button type="button" aria-label="Bold" title="Bold" className={toolbarButton} onClick={() => exec('bold')}>
            <Bold size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button type="button" aria-label="Italic" title="Italic" className={toolbarButton} onClick={() => exec('italic')}>
            <Italic size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button type="button" aria-label="Underline" title="Underline" className={toolbarButton} onClick={() => exec('underline')}>
            <Underline size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <span aria-hidden="true" className="mx-1 h-4 w-px bg-[var(--stroke)]" />
          <button type="button" aria-label="Bulleted list" title="Bulleted list" className={toolbarButton} onClick={() => exec('insertUnorderedList')}>
            <List size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button type="button" aria-label="Numbered list" title="Numbered list" className={toolbarButton} onClick={() => exec('insertOrderedList')}>
            <ListOrdered size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <span aria-hidden="true" className="mx-1 h-4 w-px bg-[var(--stroke)]" />
          <button type="button" aria-label="Attach files" title="Attach files" className={`${toolbarButton} gap-1`} onClick={() => fileRef.current?.click()}>
            <Paperclip size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>Attach</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(e) => void addFiles(e.target.files)}
          />
        </div>

        {attachments.length > 0 ? (
          <ul aria-label="Attachments" className="flex flex-wrap gap-[var(--space-2)]">
            {attachments.map((a) => (
              <li
                key={a.name}
                className="inline-flex items-center gap-[var(--space-2)] rounded-full border border-[var(--stroke)] bg-[var(--surface-subtle)] px-[var(--space-3)] py-1 font-sans text-[length:var(--text-xs)] text-[var(--ink)]"
              >
                <span className="max-w-[220px] truncate">{a.name}</span>
                <span className="text-[var(--ink-tertiary)]">{formatBytes(a.bytes)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  className="text-[var(--ink-tertiary)] hover:text-[var(--negative)]"
                  onClick={() => setAttachments((prev) => prev.filter((p) => p.name !== a.name))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {attachError ? (
          <p role="alert" className="font-sans text-[length:var(--text-xs)] text-[var(--negative)]">
            {attachError}
          </p>
        ) : null}

        <div
          ref={editorRef}
          role="textbox"
          aria-multiline="true"
          aria-label="Message"
          contentEditable
          spellCheck={false}
          suppressContentEditableWarning
          data-placeholder="Write the message. Risky wording is flagged as you type."
          onInput={(e) => {
            // Editing IS "back to editing": an armed Send attempt retires,
            // and a stale receipt must not describe text that no longer
            // exists (it also gated the live advisory off — twin-cards fix
            // overcorrection caught in review).
            setConfirmOpen(false);
            setRiskIssues(null);
            setReceipt(null);
            setBodyHtml((e.currentTarget as HTMLDivElement).innerHTML);
          }}
          className={
            'min-h-[220px] flex-1 rounded-[var(--radius-control)] border border-transparent bg-[var(--surface-subtle)] ' +
            'px-[var(--space-4)] py-[var(--space-3)] font-sans text-[length:var(--text-base)] leading-relaxed text-[var(--ink)] ' +
            'focus:outline-none focus:ring-2 focus:ring-[var(--accent)] ' +
            'empty:before:text-[var(--ink-quiet)] empty:before:content-[attr(data-placeholder)] ' +
            // Tailwind preflight strips list markers globally; restore them
            // inside the rich body so the toolbar's list buttons are visible.
            '[&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6 [&_ul]:my-1 [&_ol]:my-1'
          }
        />

        {/* Layer 1 hits (#155): one chip per flagged term. The tooltip
            explains the rule; Keep is the sender's one-click sign-off — a
            kept term never asks again, on send or anywhere else. */}
        {hits.length > 0 ? (
          <ul aria-label="Flagged terms" className="flex flex-wrap gap-[var(--space-2)]">
            {hits.map((h) => {
              const kept = acknowledged.has(h.key);
              return (
                <li
                  key={h.key}
                  title={h.note}
                  className={
                    'inline-flex items-center gap-[var(--space-2)] rounded-full border px-[var(--space-3)] py-1 font-sans text-[length:var(--text-xs)] ' +
                    (kept
                      ? 'border-[var(--stroke)] bg-[var(--surface-subtle)] text-[var(--ink-tertiary)]'
                      : 'border-[var(--hold-fill)] bg-[var(--hold-tint)] text-[var(--ink)]')
                  }
                >
                  <span className="max-w-[220px] truncate font-medium">{h.term}</span>
                  <button
                    type="button"
                    aria-label={
                      kept ? `Reconsider "${h.term}"` : `Keep "${h.term}" as written`
                    }
                    className={
                      'rounded font-medium ' +
                      (kept
                        ? 'text-[var(--ink-tertiary)] hover:text-[var(--ink)]'
                        : 'text-[var(--hold-deep)] hover:underline')
                    }
                    onClick={() => acknowledge(h.key)}
                  >
                    {kept ? '✓ kept' : 'Keep'}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        {/* Lexicon Tier-1 signals (#163): the firm's watched vocabulary,
            spell-check style. Informational only — no action, no gate. */}
        {lexiconSignals.length > 0 ? (
          <p
            aria-label="Vocabulary signals"
            className="rounded-[var(--radius-control)] bg-[var(--hold-tint)] px-[var(--space-3)] py-[var(--space-2)] font-sans text-[length:var(--text-xs)] text-[var(--hold-deep)]"
          >
            <span className="font-medium text-[var(--hold-deep)]">
              Vocabulary signals (advisory, never blocks):
            </span>{' '}
            {lexiconSignals
              .slice(0, 4)
              .map((m) => `“${m.match}” (${LEXICON_CATEGORY_SHORT[m.category]})`)
              .join(' · ')}
            {lexiconSignals.length > 4 ? ` · +${lexiconSignals.length - 4} more` : ''}
          </p>
        ) : null}

        {/* Layer 1 — the live advisory flag. Collapses once a send receipt
            exists: two cards saying the same thing is noise (found in
            preview testing, Aug 13). */}
        {fast && !receipt && fast.verdict !== 'compliant' ? (
          <div
            role="status"
            className="flex flex-col gap-[var(--space-2)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface-subtle)] px-[var(--space-4)] py-[var(--space-3)]"
          >
            <span className="flex items-center gap-[var(--space-3)]">
              <Badge tone={VERDICT_TONE[fast.verdict]}>{VERDICT_LABEL[fast.verdict]}</Badge>
              <span className="font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                {fast.reasons[0] ?? 'This wording will not pass the send-time screen.'}
              </span>
            </span>
            {fast.rewrite ? (
              <p className="font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink)]">
                {fast.rewrite}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Layer 2 — the send-time outcome. */}
        {receipt?.status === 'sent' ? (
          <div
            role="status"
            className="flex items-center gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--positive-fill)] bg-[color-mix(in_srgb,var(--positive-fill)_30%,var(--surface))] px-[var(--space-4)] py-[var(--space-3)]"
          >
            <Badge tone="positive">Sent</Badge>
            <span className="font-sans text-[length:var(--text-sm)] text-[var(--ink)]">
              Screened and delivered to the provider.
            </span>
          </div>
        ) : null}
        {receipt?.status === 'held' ? (
          <div
            role="alert"
            className="flex flex-col gap-[var(--space-2)] rounded-[var(--radius-card)] border border-[var(--hold-fill)] bg-[var(--hold-tint)] px-[var(--space-4)] py-[var(--space-3)]"
          >
            <span className="flex items-center gap-[var(--space-3)]">
              <Badge tone="hold">Held</Badge>
              <span className="font-sans text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
                Not sent. Routed to supervisory review.
              </span>
            </span>
            <p className="font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]">
              {receipt.reasons[0] ?? 'This message carries MNPI signals and needs a supervisor.'}
            </p>
          </div>
        ) : null}
        {receipt?.status === 'blocked' ? (
          <div
            role="alert"
            className="flex flex-col gap-[var(--space-2)] rounded-[var(--radius-card)] border border-[var(--negative-fill)] bg-[color-mix(in_srgb,var(--negative-fill)_30%,var(--surface))] px-[var(--space-4)] py-[var(--space-3)]"
          >
            <span className="flex items-center gap-[var(--space-3)]">
              <Badge tone="negative">Blocked</Badge>
              <span className="font-sans text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
                Not sent. This message never left the platform.
              </span>
            </span>
            <p className="font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]">
              {receipt.reasons[0] ?? 'Blocked by the communications screen.'}
            </p>
            {receipt.rewrite ? (
              <p className="font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink)]">
                {receipt.rewrite}
              </p>
            ) : null}
          </div>
        ) : null}
        {errorNotice ? (
          <div
            role="alert"
            className="rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface-subtle)] px-[var(--space-4)] py-[var(--space-3)] font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
          >
            {errorNotice}
          </div>
        ) : null}
      </div>

      {/* Send confirmation (#155) — appears ONLY when unacknowledged Layer 1
          hits remain. If everything was kept via its chip (or nothing is
          flagged), Send never asks: the sign-off already happened. */}
      <Dialog
        open={confirmDialogOpen}
        onClose={() => setConfirmOpen(false)}
        title="Flagged terms need your sign-off"
        dismissOnScrim={false}
        footer={
          <>
            <Button size="sm" variant="secondary" onClick={() => setConfirmOpen(false)}>
              Back to editing
            </Button>
            <Button size="sm" onClick={confirmAndSend}>
              {shownHits.length === 1 ? 'Acknowledge and send' : `Acknowledge ${shownHits.length} and send`}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-[var(--space-3)]">
          <span className="flex items-center gap-[var(--space-3)]">
            <Badge tone="hold">Review</Badge>
            <span className="font-sans text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
              {shownHits.length === 1
                ? '1 flagged term has no sign-off yet.'
                : `${shownHits.length} flagged terms have no sign-off yet.`}
            </span>
          </span>
          <ul className="flex flex-col gap-[var(--space-2)]">
            {shownHits.map((h) => (
              <li key={h.key} className="font-sans text-[length:var(--text-sm)] text-[var(--ink)]">
                <span className="font-medium">“{h.term}”</span>
                <span className="block text-[length:var(--text-xs)] leading-relaxed text-[var(--ink-secondary)]">
                  {h.note}
                </span>
              </li>
            ))}
          </ul>
          <p className="font-sans text-[length:var(--text-xs)] leading-relaxed text-[var(--ink-tertiary)]">
            Sending is your call. Your sign-off is recorded in the
            compliance audit, and the send-time screen still reviews every
            message for anything new. Terms you already kept will not ask
            again.
          </p>
        </div>
      </Dialog>

      <RecipientReviewDialog
        open={recipientDialogOpen}
        recipients={shownRecipientChallenge?.recipients ?? []}
        busy={sending}
        onRemove={removeRecipient}
        onCancel={(how) => {
          setRecipientChallenge(null);
          setFocusAfterClose(how === 'edit' ? 'to' : 'send');
        }}
        onApprove={() => {
          const challenge = recipientChallenge;
          if (!challenge) return;
          setRecipientApproval({ token: challenge.token, recipients: challenge.recipients, snapshot: draftKey });
          void doSend({
            ...challenge.options,
            recipientApprovalToken: challenge.token,
            recipientApprovalRecipients: challenge.recipients,
          });
        }}
      />
      <ExternalSendConfirmDialog
        open={externalDialogOpen}
        recipients={shownExternalChallenge?.recipients ?? []}
        busy={sending}
        onCancel={() => setExternalChallenge(null)}
        onConfirm={() => {
          const challenge = externalChallenge;
          if (!challenge) return;
          setExternalConfirmedFor(draftKey);
          setExternalChallenge(null);
          void doSend({ ...challenge.options, externalConfirmed: true });
        }}
      />

      {/* Soft hold (#158, decision 2): a reputational-only concern comes back
          to the SENDER. Nothing was stored or sent; the heat readout lives
          only in this dialog and dies with it. Every option SENDS or edits —
          nothing is held any more (#192). */}
      <Dialog
        open={riskIssues !== null}
        onClose={dismissRiskIssues}
        title="Risk issues: your call"
        size="lg"
        dismissOnScrim={false}
        footer={
          <>
            <Button size="sm" variant="secondary" onClick={dismissRiskIssues}>
              Draft it myself
            </Button>
            {shownRisk?.rewrite ? (
              <Button size="sm" onClick={useAiVersionAndSend}>
                Fix the risk issues and send
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" onClick={sendAsIs}>
              Send as-is
            </Button>
          </>
        }
      >
        {shownRisk ? (
          <div className="flex flex-col gap-[var(--space-3)]">
            <span className="flex items-center gap-[var(--space-3)]">
              {shownRisk.cause === 'mnpi' || shownRisk.cause === 'reputational' ? (
                <Badge tone="hold">{shownRisk.cause === 'mnpi' ? 'MNPI' : 'Front-page test'}</Badge>
              ) : null}
              <span className="font-sans text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
                {shownRisk.reasons[0] ?? 'The screen found risk issues in this message.'}
              </span>
            </span>
            {shownRisk.reasons.length > 1 ? (
              <ul className="flex list-disc flex-col gap-[var(--space-1)] pl-[var(--space-5)] font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink)]">
                {shownRisk.reasons.slice(1).map((reason, idx) => (
                  <li key={idx}>{reason}</li>
                ))}
              </ul>
            ) : null}
            {shownRisk.heat != null ? (
              <div className="flex items-center gap-[var(--space-3)]">
                <span className="shrink-0 font-sans text-[length:var(--text-sm)] font-medium text-[var(--ink-secondary)]">
                  Risk read
                </span>
                <div
                  role="meter"
                  aria-label="Risk read at send time"
                  aria-valuenow={shownRisk.heat}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-subtle)]"
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${shownRisk.heat}%`,
                      background: shownRisk.heat >= 70 ? 'var(--negative)' : 'var(--hold)',
                    }}
                  />
                </div>
                <span className="shrink-0 font-mono text-[length:var(--text-xs)] tabular-nums text-[var(--ink-secondary)]">
                  {shownRisk.heat}/100
                </span>
              </div>
            ) : null}
            <p className="font-sans text-[length:var(--text-xs)] leading-relaxed text-[var(--ink-tertiary)]">
              Shown now, saved never: this read is not stored anywhere.
              Sending is your call; your decision is what the audit records.
            </p>
            {shownRisk.advice ? (
              <p className="rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface-subtle)] px-[var(--space-4)] py-[var(--space-3)] font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink)]">
                {shownRisk.advice}
              </p>
            ) : null}
            {shownRisk.rewrite ? (
              <div className="flex flex-col gap-[var(--space-2)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface-subtle)] px-[var(--space-4)] py-[var(--space-3)]">
                <span className="font-sans text-[length:var(--text-sm)] font-medium text-[var(--ink-secondary)]">
                  Your message with the risk issues fixed, changes highlighted
                </span>
                <p className="font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink)]">
                  {rewriteDiff.map((token, idx) => (
                    <React.Fragment key={idx}>
                      {token.added ? (
                        <span className="rounded bg-[color-mix(in_srgb,var(--positive)_18%,transparent)] px-0.5 font-medium">
                          {token.text}
                        </span>
                      ) : (
                        token.text
                      )}{' '}
                    </React.Fragment>
                  ))}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </section>
  );
}
