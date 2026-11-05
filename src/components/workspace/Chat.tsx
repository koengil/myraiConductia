'use client';

/**
 * Deal chat — the workspace's answer-as-document surface, reproduced 1:1 from
 * the reference screens: top bar (title + Share), a right-aligned user bubble,
 * a "Worked for Ns" receipt reframed as a compliance receipt, then the answer
 * as a prose document (headings, bold-lead bullets), and a fixed follow-up
 * composer with source scope + model selection.
 *
 * The conversation is real state, not a single hardcoded answer. The transcript
 * is a message list held in React state — the first user turn is seeded from
 * the #q= URL fragment (a fragment never reaches a server or its logs, #331),
 * and every follow-up appends a user turn AND a contextual
 * assistant turn. Answers are canned but responsive: a small set of sell-side
 * templates (buyers, teaser, diligence, valuation, generic) keyed off the
 * question text, each rendered as the prose document with a compliance receipt.
 *
 * Conductia content: scoped to the active deal, compliance-aware, and
 * code-name-safe — no real counterparties, only "Buyer A/B/C" and code names.
 */

import { useParams } from 'next/navigation';
import * as React from 'react';

import { Composer } from '@/components/workspace/Composer';
import { logAudit } from '@/lib/audit/store';
import { DealListUnavailable } from '@/components/deals/DealsUnavailable';
import { useActiveDeal, useActiveDealState } from '@/lib/deals/useDeals';
import { resolveProjectId } from '@/lib/project/resolveProjectId';
import { readFragmentValue } from '@/lib/util/fragment';
import { useLocationHash } from '@/lib/util/useLocationHash';

const DEFAULT_QUESTION = 'Which buyers should we prioritize, and why?';

// ---- Answer model ---------------------------------------------------------
// Answers are structured blocks so every template renders through the same
// prose-document grammar (intro paragraph → headings → bold-lead bullets).

type Bullet = { lead: string; rest: string };
type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; text: string }
  | { kind: 'ul'; items: Bullet[] };

type Category = 'buyers' | 'teaser' | 'diligence' | 'valuation' | 'generic';

type SourceFile = { name: string; href: string };

type Answer = {
  category: Category;
  seconds: number;
  blocks: Block[];
  sources: SourceFile[];
};

// Real files from the Project Destiny data room, cited inline per answer so the
// conversation visibly draws on the deal's documents (like the reference's
// Sources panel). Hrefs match public/data-room (the manifest).
const SOURCES: Record<Category, SourceFile[]> = {
  buyers: [
    { name: 'Destiny European Buyers Overview - 8.29.25.pptx', href: '/data-room/04.-buyers/01.-buyers-log/destiny-european-buyers-overview-8.29.25.pptx' },
    { name: 'Project Destiny Bid Summary 10.04.25 v5.pptx', href: '/data-room/04.-buyers/05.-process-letter-and-bid-summary/02.-lois-and-term-sheets/project-destiny-bid-summary-10.04.25-v5.pptx' },
  ],
  teaser: [
    { name: 'Project Destiny Teaser - November 2025.pptx', href: '/data-room/03.-marketing-materials/02.-teaser/project-destiny-teaser-november-2025.pptx' },
    { name: 'Destiny Management Presentation - 08.28.25.pptx', href: '/data-room/03.-marketing-materials/01.-management-presentation/destiny-management-presentation-08.28.25.pptx' },
  ],
  diligence: [
    { name: 'Proj. Destiny - Phase II Data Room Index_vF.xlsx', href: '/data-room/05.-data-room/proj.-destiny-phase-ii-data-room-index-vf.xlsx' },
    { name: 'Proj. Destiny - Buyer Q&A Dry-Run - 02.24.25.docx', href: '/data-room/04.-buyers/04.-qa/proj.-destiny-buyer-qa-dry-run-02.24.25.docx' },
  ],
  valuation: [
    { name: 'Destiny Management Presentation - 08.28.25.pptx', href: '/data-room/03.-marketing-materials/01.-management-presentation/destiny-management-presentation-08.28.25.pptx' },
    { name: 'Project Destiny Bid Summary 10.04.25 v5.pptx', href: '/data-room/04.-buyers/05.-process-letter-and-bid-summary/02.-lois-and-term-sheets/project-destiny-bid-summary-10.04.25-v5.pptx' },
  ],
  generic: [
    { name: 'Project Destiny WGL - 03.19.2026.docx', href: '/data-room/01.-admin/wgl-and-team/project-destiny-wgl-03.19.2026.docx' },
    { name: 'Proj. Destiny - Initial Bid Process Letter 06.16.2025.docx', href: '/data-room/04.-buyers/05.-process-letter-and-bid-summary/01.-process-letter/proj.-destiny-initial-bid-process-letter-06.16.2025.docx' },
  ],
};

type UserMessage = { id: number; role: 'user'; text: string };
type AssistantMessage = { id: number; role: 'assistant'; answer: Answer };
type Message = UserMessage | AssistantMessage;

// ---- Template library -----------------------------------------------------
// Every name stays code-name-safe (Buyer A/B/C, "the deal"). Each template
// closes on the compliance boundary — the Conductia through-line.

const TEMPLATES: Record<Category, { seconds: number; blocks: Block[] }> = {
  buyers: {
    seconds: 24,
    blocks: [
      {
        kind: 'p',
        text: 'Based on the approved buyer universe and the current fit scoring, three names lead the field. Here is the read, with the compliance boundary noted where it matters.',
      },
      { kind: 'h', text: 'Lead the outreach' },
      {
        kind: 'ul',
        items: [
          {
            lead: 'Buyer A: composite fit 87.',
            rest: 'Strongest strategic overlap and ability to pay; the highest-conviction first call. Move under code name only.',
          },
          {
            lead: 'Buyer B, strategic tier one.',
            rest: 'Synergy case is clear on distribution; diligence load is heavier, so sequence it second.',
          },
          {
            lead: 'Buyer C, sponsor with a platform thesis.',
            rest: 'Certainty of close is the draw; expect a structured offer rather than a top-of-range headline.',
          },
        ],
      },
      { kind: 'h', text: 'The compliance boundary' },
      {
        kind: 'p',
        text: 'Every name above sits inside the deal wall. Outreach materials route through pre-send screening before anything leaves the firm, and the buyer log records each touch. I surface the decision; the managing director approves the send.',
      },
    ],
  },
  teaser: {
    seconds: 18,
    blocks: [
      {
        kind: 'p',
        text: 'The teaser travels under code name only: no identifying detail until an NDA is countersigned. Here is the shape I would lead with, and the gate it clears before it leaves the firm.',
      },
      { kind: 'h', text: 'What the teaser should carry' },
      {
        kind: 'ul',
        items: [
          {
            lead: 'The thesis in one line.',
            rest: 'Why the asset is scarce and why now; the hook a buyer forwards internally without redrawing it.',
          },
          {
            lead: 'The numbers that travel.',
            rest: 'Headline revenue, growth, and margin trajectory: blinded, indexed where a raw figure would identify the deal.',
          },
          {
            lead: 'The process line.',
            rest: 'A clean read on timing and next step so a serious buyer knows how to lean in without a phone call.',
          },
        ],
      },
      { kind: 'h', text: 'Before it leaves the firm' },
      {
        kind: 'p',
        text: 'The blinded draft routes through pre-send screening: no counterparty name, no fingerprinting detail, MNPI cleared. I prepare it; the managing director approves the release, and the send is logged against the buyer record.',
      },
    ],
  },
  diligence: {
    seconds: 31,
    blocks: [
      {
        kind: 'p',
        text: 'On the current data room and the live buyer questions, three threads are doing the work. Here is where each stands and what I would put in front of you.',
      },
      { kind: 'h', text: 'What buyers are pressing on' },
      {
        kind: 'ul',
        items: [
          {
            lead: 'Quality of earnings.',
            rest: 'Buyer A and Buyer B both want the normalization bridge; the adjustments hold, but the presentation needs a cleaner walk from reported to adjusted.',
          },
          {
            lead: 'Customer concentration.',
            rest: 'The top-account exposure is the recurring question. Contracted revenue and renewal history answer most of it: draft is ready for your review.',
          },
          {
            lead: 'Contract assignability.',
            rest: 'Change-of-control provisions are the one real gate. I have flagged the handful that need counsel before they reach a buyer.',
          },
        ],
      },
      { kind: 'h', text: 'The compliance boundary' },
      {
        kind: 'p',
        text: 'Every answer that leaves the data room is screened first, and access is logged per buyer. I assemble the response from the record; the managing director clears what is shared and with whom.',
      },
    ],
  },
  valuation: {
    seconds: 46,
    blocks: [
      {
        kind: 'p',
        text: 'On the current model and the comparable set, the defensible range holds together from three angles. Here is where the number sits and what moves it.',
      },
      { kind: 'h', text: 'Where the range sits' },
      {
        kind: 'ul',
        items: [
          {
            lead: 'Trading comparables.',
            rest: 'The public peer set frames the floor; the deal screens at a premium to the median on growth-adjusted margins.',
          },
          {
            lead: 'Precedent transactions.',
            rest: 'Recent control deals in the space support the upper half of the range, with a clear synergy-driven ceiling for a strategic.',
          },
          {
            lead: 'The base case.',
            rest: 'The intrinsic build lands mid-range; sensitivity to the out-year growth rate is the single largest swing factor.',
          },
        ],
      },
      { kind: 'h', text: 'What moves the number' },
      {
        kind: 'p',
        text: 'A strategic (Buyer A or B) can underwrite synergies a sponsor cannot, which is where the top of the range lives. Every figure here is computed from the deal record and carries its provenance: the managing director signs off before any number reaches a buyer.',
      },
    ],
  },
  generic: {
    seconds: 12,
    blocks: [
      {
        kind: 'p',
        text: 'Scoped to the active deal, here is the read. I have kept it to the decision in front of you and noted the compliance boundary where it applies.',
      },
      { kind: 'h', text: 'The read' },
      {
        kind: 'ul',
        items: [
          {
            lead: 'The decision.',
            rest: 'The next call on the deal is sequencing, not sourcing: the material is ready; the choice is order and timing.',
          },
          {
            lead: 'What I would move first.',
            rest: 'The highest-conviction step is the one already screened and drafted; it clears fastest and de-risks the rest.',
          },
          {
            lead: 'What to hold.',
            rest: 'Anything that touches a counterparty waits on your sign-off: I stage it, you release it.',
          },
        ],
      },
      { kind: 'h', text: 'The compliance boundary' },
      {
        kind: 'p',
        text: 'Everything above sits inside the deal wall. Outbound material routes through pre-send screening and is logged against the deal record. I surface the decision; the managing director approves the action.',
      },
    ],
  },
};

const TITLES: Record<Category, string> = {
  buyers: 'Buyer landscape',
  teaser: 'Teaser & marketing',
  diligence: 'Diligence & Q&A',
  valuation: 'Valuation',
  generic: 'Deal chat',
};

function classify(question: string): Category {
  const q = question.toLowerCase();
  // More-specific intents first so a phrase like "what are buyers asking in
  // diligence" resolves to diligence rather than the broad buyers template.
  if (/teaser|cim|marketing material|one[- ]?pager|info memo|memorandum|blind profile|blinded/.test(q)) {
    return 'teaser';
  }
  if (/diligence|data ?room|vdr|q&a|q & a|question|quality of earnings|qofe|concentration|assignab/.test(q)) {
    return 'diligence';
  }
  if (/valuation|valu(e|ing)|worth|pric(e|ing)|multiple|ebitda|football field|dcf|comps|comparable|range/.test(q)) {
    return 'valuation';
  }
  if (/buyer|acquir|bidder|suitor|counterpart|shortlist|outreach|approach|prioriti|sponsor|strategic/.test(q)) {
    return 'buyers';
  }
  return 'generic';
}

function buildAnswer(question: string): Answer {
  const category = classify(question);
  const t = TEMPLATES[category];
  return { category, seconds: t.seconds, blocks: t.blocks, sources: SOURCES[category] };
}

// ---- Rendering ------------------------------------------------------------

function AnswerDocument({ answer }: { answer: Answer }) {
  const params = useParams();
  const codename = useActiveDeal(
    resolveProjectId(params?.projectId as string | string[] | undefined),
  ).codename;
  return (
    <>
      {/* Compliance receipt — the "Worked for Ns" grammar, reframed as an
          audit surface (KYC / FINRA / MNPI cleared). */}
      <button
        type="button"
        className="mb-4 flex items-center gap-1 font-mono text-[length:var(--text-sm)] text-[var(--ink-tertiary)] transition-colors duration-150 hover:text-[var(--ink-secondary)]"
      >
        Screened · KYC ✓ FINRA ✓ MNPI ✓ · Worked for {answer.seconds}s ›
      </button>

      <article className="text-[length:var(--text-md)] leading-[1.62] text-[var(--ink)]">
        {answer.blocks.map((block, i) => {
          if (block.kind === 'p') {
            return (
              <p key={i} className="mb-4">
                {block.text}
              </p>
            );
          }
          if (block.kind === 'h') {
            return (
              <h3 key={i} className="mb-2 mt-6 text-[length:var(--text-md)] font-semibold text-[var(--ink)]">
                {block.text}
              </h3>
            );
          }
          return (
            <ul key={i} className="mb-4 space-y-2.5 pl-5" style={{ listStyle: 'disc' }}>
              {block.items.map((item, j) => (
                <li key={j}>
                  <span className="font-semibold">{item.lead}</span> {item.rest}
                </li>
              ))}
            </ul>
          );
        })}
      </article>

      {/* Referenced files — the deal documents this answer draws on, pulled
          from the data room. Click to open; each open is audit-logged. */}
      {answer.sources.length ? (
        <div className="mt-5 border-t border-[var(--stroke)] pt-4">
          <div className="mb-2 text-[length:var(--text-sm)] font-medium text-[var(--ink-tertiary)]">
            {answer.sources.length} referenced from the data room
          </div>
          <div className="flex flex-col gap-2">
            {answer.sources.map((s) => (
              <a
                key={s.href}
                href={s.href}
                target="_blank"
                rel="noreferrer"
                onClick={() => logAudit('dataroom', 'Opened from chat', s.name, { deal: codename })}
                className="flex items-center gap-2.5 rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] px-3 py-2 transition-colors duration-150 hover:border-[var(--stroke-strong)] hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]"
              >
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-control)] bg-[var(--surface-subtle)] font-mono text-[length:var(--text-xxs)] font-semibold uppercase text-[var(--ink-secondary)]">
                  {s.name.split('.').pop()}
                </span>
                <span className="min-w-0 flex-1 truncate text-[length:var(--text-sm)] font-medium text-[var(--ink)]">{s.name}</span>
                <span className="shrink-0 font-mono text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">Open ↗</span>
              </a>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

export function Chat() {
  // The opening question rides in the URL fragment. The server render and the
  // hydration pass cannot see it (null), so nothing is mounted, and nothing is
  // audited, until the client has read it. key={question} remounts the
  // conversation per question, so each deep link is distinct.
  const hash = useLocationHash();
  if (hash === null) return null;
  const question = readFragmentValue(hash, 'q') || DEFAULT_QUESTION;
  return <ChatConversation key={question} question={question} />;
}

function ChatConversation({ question }: { question: string }) {
  // The active deal's CODE NAME — audit entries and the composer are stamped
  // with the real deal, not a generic "the deal" (compliance record must name
  // the deal it belongs to).
  const params = useParams();
  const {
    deal: { codename },
    unavailable: dealUnavailable,
    retry: retryDeals,
  } = useActiveDealState(resolveProjectId(params?.projectId as string | string[] | undefined));

  // Chat only mounts with a #q (the /chat route renders the composer home,
  // DealHome, for the empty state). Seed the transcript from that question.
  const [messages, setMessages] = React.useState<Message[]>(() => {
    return [
      { id: 1, role: 'user', text: question },
      { id: 2, role: 'assistant', answer: buildAnswer(question) },
    ];
  });

  // Title tracks the opening question's category (Buyer landscape, Valuation…).
  const title = React.useMemo(() => {
    const first = messages.find((m) => m.role === 'assistant') as
      | AssistantMessage
      | undefined;
    return first ? TITLES[first.answer.category] : TITLES.generic;
  }, [messages]);

  const bottomRef = React.useRef<HTMLDivElement>(null);

  // Auto-scroll to the latest turn whenever the transcript grows.
  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  // Audit the OPENING question too (not just follow-ups) — the most material
  // Ask action must be on the compliance record. Fires once per conversation
  // (Chat remounts per question, so one opening per mount; ref-guarded
  // against React's double-invoke).
  const openingLogged = React.useRef(false);
  React.useEffect(() => {
    if (openingLogged.current) return;
    openingLogged.current = true;
    const first = messages.find((m) => m.role === 'user');
    if (first) logAudit('chat', 'Asked', (first as UserMessage).text, { deal: codename });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleFollowUp(text: string) {
    logAudit('chat', 'Asked', text, { deal: codename });
    setMessages((prev) => {
      const nextId = prev.length ? prev[prev.length - 1].id + 1 : 1;
      return [
        ...prev,
        { id: nextId, role: 'user', text },
        { id: nextId + 1, role: 'assistant', answer: buildAnswer(text) },
      ];
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--surface-warm)]">
      {/* Top bar */}
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--stroke)] px-6 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[length:var(--text-md)] font-medium text-[var(--ink)]">{title}</span>
          <button
            type="button"
            className="grid h-7 w-7 place-items-center rounded-[var(--radius-control)] text-[length:var(--text-lg)] leading-none text-[var(--ink-tertiary)] transition-colors duration-150 hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]"
            aria-label="Conversation menu"
          >
            …
          </button>
        </div>
      </header>

      {/* Scrollable transcript — the ONLY scroll region; the header and the
          composer stay pinned so the input never falls below the fold. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[820px] px-6 py-8">
          {messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="mb-7 flex justify-end">
                <div className="max-w-[80%] rounded-[var(--radius-composer)] bg-[var(--surface-subtle)] px-4 py-2.5 text-[length:var(--text-md)] text-[var(--ink)]">
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={m.id} className="mb-9 last:mb-0">
                <AnswerDocument answer={m.answer} />
              </div>
            ),
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Follow-up composer — pinned (shrink-0); each submit appends a user
          turn and a contextual assistant turn. */}
      <div className="shrink-0 border-t border-[var(--stroke)] px-6 py-4">
        <div className="mx-auto max-w-[820px]">
          {/* #162: the composer names the deal; with the list failed it would
              name the placeholder, so the follow-up waits for Try again. */}
          {dealUnavailable ? (
            <DealListUnavailable onRetry={retryDeals} className="py-0" />
          ) : (
            <Composer
              codename={codename}
              placeholder="Ask a follow up…"
              onSubmit={handleFollowUp}
            />
          )}
        </div>
      </div>
    </div>
  );
}
