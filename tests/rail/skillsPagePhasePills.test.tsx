import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import SkillsPage from '@/app/(authed)/projects/[projectId]/skills/page';
import { DEAL_RAIL } from '@/lib/rail/dealRail';
import { shortPhaseName } from '@/components/rail/railBoardModel';

/* The Skills filter pills and section headers name the phase, never a bare "Phase N". */

afterEach(cleanup);

describe('Skills phase pills', () => {
  it('labels every phase pill with its name and renders no bare "Phase N" pill', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<SkillsPage />);
    await screen.findByRole('heading', { name: 'Skill library' });
    const pills = screen.getAllByRole('button').map((b) => b.textContent?.trim() ?? '');
    expect(pills.filter((t) => /^Phase \d$/.test(t))).toEqual([]);
    for (const phase of DEAL_RAIL) {
      expect(screen.getByRole('button', { name: shortPhaseName(phase.name) })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: phase.name })).toBeInTheDocument();
    }
    // No bare "Phase N" eyebrow over a heading that already names the phase.
    expect(Array.from(document.querySelectorAll('.eyebrow')).filter((el) => /^Phase \d$/.test(el.textContent ?? ''))).toEqual([]);
  });
});
