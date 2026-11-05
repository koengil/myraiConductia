import { describe, it, expect, afterEach, beforeEach, vi, beforeAll, afterAll } from 'vitest';
import {
  render,
  screen,
  within,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import * as React from 'react';

import SkillsPage from '../src/app/(authed)/projects/[projectId]/skills/page';
import { shortPhaseName } from '../src/components/rail/railBoardModel';
import {
  DEAL_RAIL,
  orderedSteps,
  totalSteps,
  TEASER_STEP_ID,
} from '../src/lib/rail/dealRail';
import {
  approvalStateForStep,
  APPROVAL_STATE_LABEL,
} from '../src/components/skills/governance';
import { MotionGlobalConfig } from 'framer-motion';

// Overlay exits finish at once, so a test awaits a close without running the
// real 180 ms motion. tests/overlay/dialog.test.tsx keeps the exit on real motion.
beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});
afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});

/*
 * Skills destination — the governed library (develop-design vision spec
 * §4.5, WS5). Two contracts under test:
 *
 *   1. State-chip derivation: the approval state of every step-skill is
 *      DERIVED from the rail's two honest axes (seam-skill link + reality),
 *      never stored. The five seam skills and the live Teaser step read
 *      Active; schema steps read Approved; planned steps read Proposed.
 *   2. Library census render: all 65 step-skills render, grouped into the
 *      5 ledger phases, each card carrying its derived state chip. No
 *      self-serve toggles, no Pro paywall.
 */

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  errorSpy.mockRestore();
});

describe('skill governance — approval-state derivation', () => {
  it('derives Active for the seam-linked steps plus the live Teaser and MD Briefing steps', () => {
    const steps = orderedSteps();

    // The typed seam links: exactly five steps carry a live seam skill.
    const seamLinked = steps.filter((s) => s.skillId);
    expect(seamLinked.map((s) => s.skillId).sort()).toEqual([
      'acquirer-fit',
      'culture-signal',
      'deal-readiness',
      'financial-performance',
      'synergy-engine',
    ]);
    for (const step of seamLinked) {
      expect(approvalStateForStep(step)).toBe('active');
    }

    // The spine-wired steps are equally Active (reality: live).
    const teaser = steps.find((s) => s.id === TEASER_STEP_ID);
    expect(teaser).toBeDefined();
    expect(approvalStateForStep(teaser!)).toBe('active');
    const briefing = steps.find((s) => s.id === 'p1-s9');
    expect(approvalStateForStep(briefing!)).toBe('active');

    // Active = the 5 seam links + the two live steps, nothing else.
    const active = steps.filter((s) => approvalStateForStep(s) === 'active');
    expect(active).toHaveLength(7);
  });

  it('derives Approved from schema reality and Proposed from planned, across all 65', () => {
    const steps = orderedSteps();
    expect(steps).toHaveLength(65);

    let approved = 0;
    let proposed = 0;
    for (const step of steps) {
      const state = approvalStateForStep(step);
      if (step.skillId || step.reality === 'live') {
        expect(state).toBe('active');
      } else if (step.reality === 'schema') {
        expect(state).toBe('approved');
        approved += 1;
      } else {
        expect(state).toBe('proposed');
        proposed += 1;
      }
    }

    // Both non-active states are populated (the census is honest: some
    // contracts have canned drafts, most are still ledger-only).
    expect(approved).toBeGreaterThan(0);
    expect(proposed).toBeGreaterThan(0);
    expect(approved + proposed).toBe(65 - 7);

    // Spot checks on the canonical examples.
    const conflicts = steps.find((s) => s.id === 'p1-s6');
    expect(approvalStateForStep(conflicts!)).toBe('approved');
    const targetUniverse = steps.find((s) => s.id === 'p1-s1');
    expect(approvalStateForStep(targetUniverse!)).toBe('proposed');
  });
});

describe('skills library — census render', () => {
  it('renders all 65 step-skills grouped into the 5 ledger phases', async () => {
    render(<SkillsPage />);

    expect(
      await screen.findByRole('heading', { name: 'Skill library' }),
    ).toBeInTheDocument();

    // Every phase renders as its own section holding exactly its steps.
    let rendered = 0;
    for (const phase of DEAL_RAIL) {
      const section = screen.getByRole('region', {
        name: `Phase ${phase.index}: ${phase.name}`,
      });
      const cards = within(section).getAllByRole('button', {
        name: /step skill$/,
      });
      expect(cards).toHaveLength(phase.steps.length);
      rendered += cards.length;
    }
    expect(rendered).toBe(totalSteps());
    expect(rendered).toBe(65);
  });

  it('carries the derived state chip on every card', async () => {
    render(<SkillsPage />);
    // Flush the async seam-skill load inside act before sync assertions.
    await screen.findByRole('heading', { name: 'Skill library' });

    for (const step of orderedSteps()) {
      const card = screen.getByRole('button', {
        name: `${step.title} step skill`,
      });
      const state = approvalStateForStep(step);
      expect(card).toHaveAttribute('data-approval-state', state);
      expect(within(card).getByText(APPROVAL_STATE_LABEL[state])).toBeInTheDocument();
    }

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('filters by owner, priority, and phase without self-serve toggles', async () => {
    render(<SkillsPage />);
    await screen.findByRole('heading', { name: 'Skill library' });
    const steps = orderedSteps();

    // ★ filter → exactly the priority builds.
    fireEvent.click(screen.getByRole('button', { name: '★ Priority' }));
    expect(screen.getAllByRole('button', { name: /step skill$/ })).toHaveLength(
      steps.filter((s) => s.priorityBuild).length,
    );

    // Owner filter → the Futureproofing OS hybrid steps.
    fireEvent.click(screen.getByRole('button', { name: 'Futureproofing' }));
    expect(screen.getAllByRole('button', { name: /step skill$/ })).toHaveLength(
      steps.filter((s) => s.buildOwner === 'futureproofing-os').length,
    );

    // Phase filter → only that phase's section survives.
    fireEvent.click(screen.getByRole('button', { name: shortPhaseName(DEAL_RAIL[3].name) }));
    expect(screen.getAllByRole('button', { name: /step skill$/ })).toHaveLength(
      DEAL_RAIL[3].steps.length,
    );
    const phaseOneSection = { name: `Phase 1: ${DEAL_RAIL[0].name}` };
    expect(screen.queryByRole('region', phaseOneSection)).toBeNull();

    // Back to all.
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getAllByRole('button', { name: /step skill$/ })).toHaveLength(65);
    // The same query finds the section when it renders, so the check above can fail.
    expect(screen.getByRole('region', phaseOneSection)).toBeInTheDocument();

    // Governance replaces self-serve enablement: no switches anywhere.
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('opens the reduced skill detail: value + governance, no io mechanism, no tabs', async () => {
    render(<SkillsPage />);
    await screen.findByRole('heading', { name: 'Skill library' });

    // Exit Readiness (p1-s2) carries the deal-readiness seam skill.
    fireEvent.click(
      screen.getByRole('button', { name: 'Exit Readiness step skill' }),
    );

    const dialog = await screen.findByRole('dialog', {
      name: /^Exit Readiness/,
    });

    // Provenance line: seq + phase (unchanged).
    expect(
      within(dialog).getByText(/Step 2 of 65 · Phase 1/),
    ).toBeInTheDocument();

    // WS6: the panel exposes the VALUE, not the mechanism. "Why it's better"
    // and the governance blocks are present; the seam panel is noted and the
    // approval gate reads through.
    expect(
      within(dialog).getByRole('region', { name: "Why it's better" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Scores a seller/)).toBeInTheDocument();
    expect(
      within(dialog).getByRole('region', { name: 'Approval state' }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('region', { name: 'Approval gate' }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText('Banker reviews the scoring before acting on it'),
    ).toBeInTheDocument();
    expect(await within(dialog).findByText('Deal Readiness')).toBeInTheDocument();

    // The io mechanism and the tabbed contract are WITHHELD from the banker
    // surface: no io lanes, no Contract/Governance tabs, no execution-class code.
    expect(within(dialog).queryByRole('region', { name: 'Inputs' })).toBeNull();
    expect(
      within(dialog).queryByRole('region', { name: 'Transformation' }),
    ).toBeNull();
    expect(within(dialog).queryByRole('region', { name: 'Outputs' })).toBeNull();
    expect(within(dialog).queryByRole('tab', { name: 'Contract' })).toBeNull();
    expect(within(dialog).queryByRole('tab', { name: 'Governance' })).toBeNull();
    expect(
      within(dialog).queryByText('Agent, human approves'),
    ).toBeNull();

    // Escape closes the dialog.
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /^Exit Readiness/ })).toBeNull(),
    );

    expect(errorSpy).not.toHaveBeenCalled();
  });
});
