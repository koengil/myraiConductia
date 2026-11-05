'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';

import { resolveProjectId } from '@/lib/project/resolveProjectId';
import { getApi } from '@/lib/api';
import type { TeamMember } from '@/lib/api/types';
import { useFlag } from '@/lib/flags/FlagsContext';
import { StageStatus } from '@/components/shell/StageStatus';
import { TeamDrawer } from '@/components/team/TeamDrawer';
import { TeamRoster } from '@/components/team/TeamRoster';
import {
  MessageComposer,
  type SentMessage,
} from '@/components/team/MessageComposer';

/**
 * /team — the compliance theatre as a navigable destination
 * (personas-and-jobs §2 Job 4; design spec §10.2 platform route reframe).
 *
 * Editorial Institutional: the warm working surface read as a real
 * communications instrument. The headline beat is the gate — clean→delivered
 * and risky→blocked, the live FINRA reason given full weight (the moat made
 * visible, strategy-and-moat.md §1).
 *
 * This route composes the existing primitives directly. It is NOT a stage in
 * the linear spine: there is no Continue affordance, no NEXT/BACK dispatch,
 * no SELECT_ACQUIRER. The destination is itself; the MD navigates via the
 * platform nav.
 *
 * Compliance dispatches from MessageComposer (SET_COMPLIANCE scanning / clear
 * / blocked) flow to the global ribbon through its own contract — preserved
 * byte-identically by NOT modifying the composer.
 *
 * Recipient selection: the page owns a local React.useState seeded to the
 * first non-MD member (advisor-first by default, but generalised — any non-MD
 * teammate may be the recipient). TeamDrawer does not currently expose a
 * selection callback and MUST NOT be modified; the page renders a chat-thread
 * switcher so the MD can move between conversations without altering the
 * drawer's contract.
 *
 * PER-RECIPIENT THREAD PERSISTENCE (the core fix): the page owns a
 * `threadsByRecipient` map (recipientId → SentMessage[]) and a monotonic id
 * counter. Because this state lives at the page level — which does NOT unmount
 * when the MD switches recipients — each teammate's conversation survives the
 * switch. The composer is the controlled view of the active recipient's
 * thread: a compliant send calls `onDelivered`, which appends to that
 * recipient's slice; switching recipients re-feeds the composer the target's
 * intact thread. Hold/blocked verdicts are stopped in the composer and never
 * reach the map. The composer still keys on recipient id so transient,
 * recipient-scoped UI (in-flight body, verdict notice) resets on switch while
 * the durable thread persists here.
 *
 * Async load: an unmount-safe `active` flag, try/catch with console.error,
 * terminal rendering on every branch. StageStatus owns the look; this caller
 * owns the asserted strings + their role/aria (master §3.6.2).
 */

type LoadState = 'loading' | 'ready' | 'error';

export default function TeamPage() {
  const liveTeam = useFlag('platform_onboarding');
  return liveTeam ? <TeamRoster /> : <FixtureTeamWorkspace />;
}

/** Preserve the existing ConductiaAPI-backed demo until onboarding is live. */
function FixtureTeamWorkspace() {
  const teamProjectId = resolveProjectId(
    (useParams()?.projectId as string | string[] | undefined),
  );
  const [members, setMembers] = React.useState<TeamMember[]>([]);
  const [loadState, setLoadState] = React.useState<LoadState>('loading');
  const [recipientId, setRecipientId] = React.useState<string | null>(null);

  // Durable per-recipient threads. Keyed by recipient id, owned here at the
  // page so they survive recipient switches (the page does not unmount when
  // the MD moves between conversations). Only delivered (compliance-cleared)
  // messages ever enter this map — the composer gates hold/blocked verdicts
  // before calling onDelivered.
  const [threadsByRecipient, setThreadsByRecipient] = React.useState<
    Record<string, SentMessage[]>
  >({});
  // Monotonic id shared across every thread, so ids never collide between
  // conversations.
  const nextMessageIdRef = React.useRef(1);

  const handleDelivered = React.useCallback((toId: string, body: string) => {
    const id = nextMessageIdRef.current++;
    setThreadsByRecipient((prev) => ({
      ...prev,
      [toId]: [...(prev[toId] ?? []), { id, body }],
    }));
  }, []);

  React.useEffect(() => {
    let active = true;
    const api = getApi();

    async function load() {
      try {
        const roster = await api.getTeam(teamProjectId);
        if (!active) return;
        setMembers(roster);
        // First non-MD member is the default recipient (advisor-first).
        const firstNonMd = roster.find((m) => m.role !== 'MD') ?? null;
        setRecipientId(firstNonMd ? firstNonMd.id : null);
        setLoadState('ready');
      } catch (err) {
        console.error('[Team route] failed to load team', { err });
        if (!active) return;
        setLoadState('error');
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [teamProjectId]);

  if (loadState === 'loading') {
    return (
      <StageStatus kind="loading" eyebrow="Team">
        <p
          role="status"
          aria-live="polite"
          className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
        >
          Loading team…
        </p>
      </StageStatus>
    );
  }

  if (loadState === 'error') {
    return (
      <StageStatus kind="error" eyebrow="Team">
        <p
          role="status"
          className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
        >
          The team roster could not be loaded right now.
        </p>
      </StageStatus>
    );
  }

  const recipient =
    members.find((m) => m.id === recipientId) ??
    members.find((m) => m.role !== 'MD') ??
    null;

  const recipientOptions = members.filter((m) => m.role !== 'MD');
  const canMessage = recipientOptions.length > 0 && recipient !== null;

  return (
    <section
      aria-label="Compliance theatre"
      className="page-shell flex w-full flex-1 flex-col gap-[var(--space-6)] py-[var(--space-6)]"
    >
      <TeamDrawer />

      {canMessage ? (
        recipientOptions.length > 1 ? (
          <div className="grid items-start gap-[var(--space-5)] lg:grid-cols-[minmax(0,20rem)_1fr]">
            <nav
              aria-label="Conversations"
              className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-4)]"
            >
              <div className="flex items-baseline justify-between gap-[var(--space-3)]">
                <span className="eyebrow">Conversations</span>
                <span className="font-sans text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                  {recipientOptions.length} threads
                </span>
              </div>
              <ul className="flex flex-col gap-[var(--space-1)]">
                {recipientOptions.map((m) => {
                  const active = recipient ? m.id === recipient.id : false;
                  const count = threadsByRecipient[m.id]?.length ?? 0;
                  const last = threadsByRecipient[m.id]?.at(-1)?.body;
                  const preview = last ?? 'No cleared messages yet';
                  return (
                    <li key={m.id}>
                      <button
                        type="button"
                        aria-current={active ? 'true' : undefined}
                        aria-label={`Open conversation with ${m.name}`}
                        onClick={() => setRecipientId(m.id)}
                        className={
                          'flex min-h-[48px] w-full items-center gap-[var(--space-3)] rounded-[var(--radius-input)] border px-[var(--space-3)] py-[var(--space-3)] text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ' +
                          (active
                            ? 'border-transparent bg-[var(--surface-subtle)]'
                            : 'border-transparent hover:bg-[var(--surface-raised)]')
                        }
                      >
                        <span
                          aria-hidden="true"
                          className={
                            'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border font-mono text-[length:var(--text-xs)] font-medium tracking-[0.02em] ' +
                            (active
                              ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]'
                              : 'border-[var(--stroke)] bg-[var(--surface-subtle)] text-[var(--ink-secondary)]')
                          }
                        >
                          {m.initials}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-[1px]">
                          <span className="flex items-baseline justify-between gap-[var(--space-2)]">
                            <span className="truncate font-sans text-[length:var(--text-md)] font-medium tracking-tight text-[var(--ink)]">
                              {m.name}
                            </span>
                            <span className="shrink-0 font-sans text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                              {m.role}
                            </span>
                          </span>
                          <span className="flex items-baseline justify-between gap-[var(--space-2)]">
                            <span
                              className={
                                'truncate font-sans text-[length:var(--text-xs)] ' +
                                (last
                                  ? 'text-[var(--ink-secondary)]'
                                  : 'italic text-[var(--ink-tertiary)]')
                              }
                            >
                              {preview}
                            </span>
                            {count > 0 ? (
                              <span className="shrink-0 font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                                {count}
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>

            <MessageComposer
              key={recipient.id}
              toId={recipient.id}
              toName={recipient.name}
              thread={threadsByRecipient[recipient.id] ?? []}
              onDelivered={(text) => handleDelivered(recipient.id, text)}
            />
          </div>
        ) : (
          <MessageComposer
            key={recipient.id}
            toId={recipient.id}
            toName={recipient.name}
            thread={threadsByRecipient[recipient.id] ?? []}
            onDelivered={(text) => handleDelivered(recipient.id, text)}
          />
        )
      ) : null}
    </section>
  );
}
