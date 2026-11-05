import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import * as React from 'react';

import { TeamRoster } from '../src/components/team/TeamRoster';
import {
  SEED_TEAM,
  TEAM_SIDE_LABELS,
  groupBySide,
} from '../src/lib/team/roster';

/*
 * Team — the cross-party roster (people, not files).
 *
 * Contracts under test:
 *   1. Every seeded person renders, grouped under their side's section header.
 *   2. Each person carries reach-out actions: a mailto: email link, and a tel:
 *      call link when a phone number exists.
 *   3. Off-platform parties carry the disabled "Invite to deal" affordance.
 */

// TeamRoster reads the active projectId via useParams().
vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'project-summit' }),
}));

afterEach(() => cleanup());

describe('TeamRoster fixture', () => {
  it('renders a section header for every non-empty side', () => {
    render(<TeamRoster />);
    for (const { label } of groupBySide(SEED_TEAM)) {
      expect(
        screen.getByRole('heading', { name: label }),
      ).toBeInTheDocument();
    }
    // Sanity: the four canonical side labels are defined.
    expect(Object.keys(TEAM_SIDE_LABELS)).toHaveLength(4);
  });

  it('renders every seeded person with tel: and mailto: actions', () => {
    render(<TeamRoster />);

    for (const person of SEED_TEAM) {
      // The person is on the roster.
      expect(screen.getByText(person.name)).toBeInTheDocument();

      // Email is always reachable (mailto:).
      const email = screen.getByRole('link', { name: `Email ${person.name}` });
      expect(email).toHaveAttribute('href', `mailto:${person.email}`);

      // Call is reachable (tel:) when a phone number exists.
      if (person.phone) {
        const call = screen.getByRole('link', { name: `Call ${person.name}` });
        expect(call).toHaveAttribute('href', `tel:${person.phone}`);
      }
    }
  });

  it('shows a disabled "Invite to deal" affordance for off-platform parties', () => {
    render(<TeamRoster />);
    const offPlatform = SEED_TEAM.filter((p) => p.platformStatus === 'off-platform');
    expect(offPlatform.length).toBeGreaterThan(0);

    const invites = screen.getAllByRole('button', { name: /Invite to deal/ });
    expect(invites).toHaveLength(offPlatform.length);
    for (const invite of invites) {
      expect(invite).toBeDisabled();
    }
  });
});
