import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import * as React from 'react';

import SkillShelf from '../src/components/skills/SkillShelf';

describe('SkillShelf', () => {
  it('renders all five skills from the API seam', async () => {
    render(<SkillShelf />);

    // Async: the shelf fetches getApi().getSkills() on mount before cards
    // render. Names are the frozen-fixture catalogue display names.
    expect(
      await screen.findByText('Financial Performance'),
    ).toBeInTheDocument();
    expect(await screen.findByText('Acquirer Fit')).toBeInTheDocument();
    expect(await screen.findByText('Culture Signal')).toBeInTheDocument();
    expect(await screen.findByText('Deal Readiness')).toBeInTheDocument();
    expect(
      await screen.findByText('Synergy & Deal-Structuring Engine'),
    ).toBeInTheDocument();
  });

  it('marks only the premium skill with a Pro / lock indicator', async () => {
    render(<SkillShelf />);

    // The premium skill (synergy-engine) exposes a Pro-locked accessible name.
    const proCard = await screen.findByLabelText(
      /Synergy & Deal-Structuring Engine, Pro skill, locked/,
    );
    expect(proCard).toBeInTheDocument();
    expect(within(proCard).getByText('Pro')).toBeInTheDocument();

    // Exactly one Pro indicator across the whole shelf — the four free
    // skills carry none.
    expect(screen.getAllByText('Pro')).toHaveLength(1);

    // A free skill is reachable by its plain (non-locked) accessible name and
    // carries no Pro badge.
    const freeCard = await screen.findByLabelText(
      /Financial Performance skill/,
    );
    expect(freeCard).toBeInTheDocument();
    expect(within(freeCard).queryByText('Pro')).toBeNull();
  });
});
