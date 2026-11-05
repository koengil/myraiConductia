'use client';

import { Mail, Phone, UserPlus } from 'lucide-react';

import { Pill } from '@/components/atoms';
import { DealListUnavailableStage, NotOnDealStage } from '@/components/deals/DealsUnavailable';
import { DESTINATION_TITLES } from '@/lib/perspective/destinationTitles';
import type { BadgeTone } from '@/components/atoms';
import { useFlag } from '@/lib/flags/FlagsContext';
import { useProjectId } from '@/lib/project/useProjectId';
import { useResolvedDeal } from '@/lib/deals/useDeals';
import {
  groupBySide,
  teamRosterFor,
  type PlatformStatus,
  type TeamPerson,
  type TeamSection,
} from '@/lib/team/roster';
import { LiveTeamRoster } from './LiveTeamRoster';
import { PartyColumn, PARTY_COLUMN_GRID } from './PartyColumn';

/**
 * Team roster across every party on the deal (people, not files).
 *
 * One COLUMN per side (client / sell-advisors / buyers / buy-advisors): the
 * perimeter made visible as a presentational regrouping of the same roster
 * data. Each column is a white card with the side heading and quiet person
 * rows; a person's platform status renders in the existing dot-pill
 * vocabulary. Each row keeps its click-to-call (`tel:`) and email (`mailto:`)
 * actions, and an off-platform party carries the disabled `[Later]`
 * "Invite to deal" affordance (the network-effects seed). This is people
 * only: buyer scoring lives on the deal's "Buyers" lens, and general company
 * research on the global "Companies" search.
 */

function InviteButton({ person }: { person: TeamPerson }) {
  if (person.platformStatus !== 'off-platform') return null;
  return (
    <button
      type="button"
      disabled
      aria-disabled="true"
      title="Coming soon"
      className="inline-flex cursor-not-allowed items-center gap-[6px] rounded-[var(--radius-button)] border border-[var(--stroke)] bg-[var(--surface-subtle)] px-[var(--space-3)] py-[7px] text-[length:var(--text-xs)] font-medium text-[var(--ink-tertiary)] opacity-70"
    >
      <UserPlus size={14} strokeWidth={1.75} aria-hidden />
      Invite to deal
      <span className="font-mono text-[length:var(--text-xxs)] text-[var(--ink-tertiary)]">Later</span>
    </button>
  );
}

/**
 * The existing platform-status vocabulary as a boundary pill. Off-platform
 * people carry the invite affordance instead of a pill.
 */
const PLATFORM_STATUS_PILL: Record<
  PlatformStatus,
  { tone: BadgeTone; label: string } | null
> = {
  'on-platform': { tone: 'positive', label: 'Joined' },
  invited: { tone: 'hold', label: 'Invite pending' },
  'off-platform': null,
};

function PlatformStatusPill({ status }: { status?: PlatformStatus }) {
  const pill = status ? PLATFORM_STATUS_PILL[status] : null;
  if (!pill) return null;
  return (
    <Pill tone={pill.tone} className="w-fit shrink-0">
      {pill.label}
    </Pill>
  );
}

function ContactRow({ person }: { person: TeamPerson }) {
  return (
    <li className="flex min-h-[48px] flex-col gap-[var(--space-2)] px-[var(--space-4)] py-[var(--space-3)]">
      <div className="flex items-start justify-between gap-[var(--space-2)]">
        <div className="min-w-0">
          <p className="truncate text-[length:var(--text-base)] font-medium text-[var(--ink)]">
            {person.name}
          </p>
          <p className="truncate text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
            {person.role} · {person.firm}
          </p>
        </div>
        <PlatformStatusPill status={person.platformStatus} />
      </div>

      <div className="flex flex-wrap items-center gap-[var(--space-2)]">
        <a
          href={`tel:${person.phone ?? ''}`}
          aria-label={`Call ${person.name}`}
          aria-disabled={person.phone ? undefined : 'true'}
          onClick={(e) => {
            if (!person.phone) e.preventDefault();
          }}
          className={[
            'inline-flex items-center gap-[6px] rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-3)] py-[7px] text-[length:var(--text-xs)] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
            person.phone
              ? 'text-[var(--ink-secondary)] hover:bg-[var(--surface-raised)]'
              : 'cursor-not-allowed text-[var(--ink-tertiary)] opacity-60',
          ].join(' ')}
        >
          <Phone size={14} strokeWidth={1.75} aria-hidden />
          Call
        </a>
        <a
          href={`mailto:${person.email}`}
          aria-label={`Email ${person.name}`}
          className="inline-flex items-center gap-[6px] rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-3)] py-[7px] text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <Mail size={14} strokeWidth={1.75} aria-hidden />
          Email
        </a>
        <InviteButton person={person} />
      </div>
    </li>
  );
}

function SideColumn({ section }: { section: TeamSection }) {
  return (
    <PartyColumn label={section.label} count={section.people.length}>
      {section.people.map((person) => (
        <ContactRow key={person.id} person={person} />
      ))}
    </PartyColumn>
  );
}

export function TeamRoster() {
  // platform_onboarding ON swaps the fixture roster for the live surface
  // (GET /members + invites + phase controls). OFF keeps today's fixture
  // rendering untouched.
  const live = useFlag('platform_onboarding');
  if (live) return <LiveTeamRoster />;
  return <FixtureTeamRoster />;
}

function FixtureTeamRoster() {
  // The roster is scoped to the active deal (the page is a per-deal route):
  // each deal resolves its own Team roster, so switching deals
  // changes the people, not just the header.
  const dealId = useProjectId();
  const identity = useResolvedDeal(dealId);
  const sections = groupBySide(teamRosterFor(dealId));

  if (identity.status === 'error') {
    // The deal list failed (#162): never "not found", never a fixture.
    return <DealListUnavailableStage onRetry={identity.retry} />;
  }

  if (identity.status === 'unknown') {
    // Not in the viewer's deal list: the list is the deals they are on.
    return <NotOnDealStage title={DESTINATION_TITLES.team} />;
  }

  return (
    <section
      aria-label="Team roster"
      className="flex h-full min-h-0 w-full flex-col overflow-y-auto bg-[var(--surface-warm)]"
    >
      <header className="flex shrink-0 flex-col gap-[var(--space-1)] border-b border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-5)] py-[var(--space-4)]">
        <h1 className="text-[length:var(--text-lg)] font-semibold leading-tight text-[var(--ink)]">
          Team
        </h1>
        <p className="max-w-3xl text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          One column per side. External parties see only what their boundary
          allows: never the Deal Folder, Mail, or the Buyers lens.
        </p>
      </header>

      <div className="flex flex-col gap-[var(--space-4)] px-[var(--space-5)] py-[var(--space-5)]">
        <div className={PARTY_COLUMN_GRID}>
          {sections.map((section) => (
            <SideColumn key={section.side} section={section} />
          ))}
        </div>

        <p className="max-w-3xl rounded-[var(--radius-card)] border border-[var(--hold-fill)] bg-[var(--hold-tint)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-xs)] text-[var(--ink)]">
          <span className="font-medium">Boundary legend.</span> Client and buyers
          reach only their staged rooms. Buyer access is phase-gated behind the
          NDA. Every cross-boundary view is logged.
        </p>
      </div>
    </section>
  );
}

export default TeamRoster;
