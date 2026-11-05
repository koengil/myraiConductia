import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, waitFor, fireEvent, cleanup } from '@testing-library/react';
import * as React from 'react';

import MandatePage from '../src/app/(authed)/projects/[projectId]/page';
import ChatPage from '../src/app/(authed)/projects/[projectId]/chat/page';
import AcquirersPage from '../src/app/(authed)/projects/[projectId]/acquirers/page';
// AcquirerDetailPage import omitted while the suspension-in-jsdom case is
// skipped (see the `it.skip` for rationale and coverage hand-off).
import TeamPage from '../src/app/(authed)/projects/[projectId]/team/page';
import SkillsPage from '../src/app/(authed)/projects/[projectId]/skills/page';
import { SessionProvider } from '../src/lib/session/store';

/*
 * Golden path — platform model (post-F5 lockstep rewrite per F-plan §10.6).
 *
 * REPLACES the linear-spine golden path (deleted alongside the auto-advancing
 * spine in F5). The §R race that plagued the old spine test is gone at source
 * — Intent's reduced-motion `setTimeout(0)` clear+NEXT is retired and no
 * stage unmounts itself; navigation is explicit.
 *
 * This suite renders each platform destination in isolation and asserts the
 * MD-facing wow beats survive byte-identically. Inner primitive contracts
 * (ComplianceRibbon, ScoreDial, PaywallLock, MessageComposer, SkillShelf,
 * panels) are guaranteed by their per-component suites; THIS suite verifies
 * the route-level composition.
 *
 * Each section asserts zero `console.error` on the happy path — the same
 * silence-the-console contract the original golden path enforced.
 */

// Minimal `next/navigation` mock: route pages only call useRouter().push
// (Acquirers card click), useParams() (the project-scoped routes read the
// active projectId), and `Link` (the Acquirer-detail back affordance). We
// assert push was called with the expected href; Link renders as a real
// anchor that React-Testing-Library can see. The pages render in isolation
// here, so useParams returns the sandbox project ('project-summit').
const pushSpy = vi.fn();
const replaceSpy = vi.fn();
const redirectSpy = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
vi.mock('next/navigation', () => ({
  redirect: (url: string) => redirectSpy(url),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => ({
    push: pushSpy,
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: replaceSpy,
    prefetch: vi.fn(),
  }),
  useParams: () => ({ projectId: 'project-summit' }),
  usePathname: () => '/projects/project-summit',
  useSearchParams: () => new URLSearchParams(),
}));

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  pushSpy.mockClear();
  replaceSpy.mockClear();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  errorSpy.mockRestore();
});

describe('Golden path — platform model', () => {
  it('Deal dashboard: the project home shows live vitals and quick links', async () => {
    // The deal index is a server component since the external scoped shell
    // (cr-prr-124 1.2). Flag resolution fails closed in jsdom (no Supabase
    // env), which IS the internal path: it returns PR #123's ProjectDashboard.
    // tests/external-deal-home.test.tsx covers the external branch.
    const home = await MandatePage({ params: Promise.resolve({ projectId: 'project-summit' }) });
    render(<SessionProvider>{home}</SessionProvider>);

    expect(await screen.findByRole('heading', { name: /Project Summit/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Mandate vitals')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Deal rail/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Ask/i })).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('Ask /chat is not reachable in the MVP', () => {
    expect(() => ChatPage()).toThrow('NEXT_NOT_FOUND');
  });

  it('Acquirers: ranked landscape with composite scores; card click navigates', async () => {
    render(
      <SessionProvider>
        <AcquirersPage />
      </SessionProvider>,
    );

    // Hero card (rank 1) + at least 4 row cards = 5 acquirer cards by the
    // aria contract `${name}, composite score ${total}`.
    const anthropic = await screen.findByRole('button', {
      name: /Anthropic, composite score 87/,
    });
    expect(anthropic).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: /Salesforce, composite score 67/,
      }),
    ).toBeInTheDocument();

    // The ranking is DESC: at least one card scores higher than Salesforce.
    const allCards = screen.getAllByRole('button', {
      name: /composite score/,
    });
    expect(allCards.length).toBeGreaterThanOrEqual(5);

    // Click the top card → router.push to the project-scoped deep-dive. URL is
    // the source of truth; no SELECT_ACQUIRER / NEXT dispatch (the F5 reframe).
    fireEvent.click(anthropic);
    expect(pushSpy).toHaveBeenCalledWith(
      '/projects/project-summit/acquirers/anthropic',
    );

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('Team: roster + composer mount; the FROZEN composer affordances exist', async () => {
    render(
      <SessionProvider>
        <TeamPage />
      </SessionProvider>,
    );

    // The team theatre section. The compliance through-line survives the team
    // redesign (2026-06-12) — it is now the TeamDrawer's framing copy rather
    // than a section heading. Wait for the drawer's own async roster to settle
    // before asserting against it.
    const section = await screen.findByLabelText('Compliance theatre');
    await waitFor(() =>
      expect(
        within(section).getByText(
          /routes through compliance before it sends/i,
        ),
      ).toBeInTheDocument(),
    );

    const intake = within(section).getByLabelText('Assigned at project creation');
    expect(intake).toBeInTheDocument();
    expect(within(intake).getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(within(intake).getByRole('columnheader', { name: 'Role' })).toBeInTheDocument();
    expect(within(intake).getByRole('columnheader', { name: 'Added by' })).toBeInTheDocument();
    expect(within(intake).getByRole('columnheader', { name: 'On deal since' })).toBeInTheDocument();
    expect(within(intake).getByText('James Watt')).toBeInTheDocument();
    expect(within(intake).getAllByText('Storm Duncan').length).toBeGreaterThanOrEqual(1);
    expect(within(intake).getAllByText('2026-05-01').length).toBe(3);
    expect(
      within(section).queryByText(/No addressable recipients in the roster/i),
    ).toBeNull();

    // The roster reveals the MD + the advisors. Both appear at least once
    // (the page mounts TeamDrawer + a recipient selector; advisor names
    // legitimately appear in both — that is correct UI, not a duplicate).
    expect(
      within(section).getAllByText('Storm Duncan').length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      within(section).getAllByText('Sarah Reid').length,
    ).toBeGreaterThanOrEqual(1);

    // The composer's FROZEN demo-insert affordances (ledger §3.2) are mounted:
    // the one-click clean/risky samples that make compliance screening
    // demonstrable live.
    expect(
      within(section).getByRole('button', { name: 'Clean message' }),
    ).toBeInTheDocument();
    expect(
      within(section).getByRole('button', { name: 'Risky message' }),
    ).toBeInTheDocument();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('Skills: the governed library renders the 65 step-skills; the Pro upsell is gone', async () => {
    render(
      <SessionProvider>
        <SkillsPage />
      </SessionProvider>,
    );

    // The governed-library framing (develop-design vision spec §4.5 replaced
    // the catalogue-with-upsell surface on 2026-07-08).
    expect(
      await screen.findByRole('heading', { name: 'Skill library' }),
    ).toBeInTheDocument();

    // The full canonical census renders: 65 step-skill cards.
    const cards = screen.getAllByRole('button', { name: /step skill$/ });
    expect(cards).toHaveLength(65);

    // The live seam skills surface as Active on their rail steps (Buyer
    // Universe carries acquirer-fit).
    const buyerUniverse = screen.getByRole('button', {
      name: 'Buyer Universe step skill',
    });
    expect(buyerUniverse).toHaveAttribute('data-approval-state', 'active');

    // The Pro paywall is deprecated on this surface: no Upgrade affordance,
    // no locked-Pro aria, no self-serve toggles.
    expect(screen.queryByRole('button', { name: /Upgrade/ })).toBeNull();
    expect(screen.queryByLabelText(/Pro skill, locked/)).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();

    expect(errorSpy).not.toHaveBeenCalled();
  });
});
