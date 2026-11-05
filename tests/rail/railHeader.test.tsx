import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { RailHeader } from '@/components/rail/RailHeader';
import type { RailHeaderProgress } from '@/components/rail/railBoardModel';

const PROGRESS: RailHeaderProgress = {
  phase: null,
  line: 'Preparation · 4 of 13 steps done',
  done: 4,
  total: 61,
  pct: 7,
};

afterEach(() => cleanup());

describe('RailHeader', () => {
  it('keeps one heading that names the deal, with the codename hidden from sight', () => {
    render(<RailHeader dealName="Project Kestrel" progress={PROGRESS} />);

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveAccessibleName('Project Kestrel Rail');
    // Codename once: the switcher shows it on screen, so the heading's copy is
    // for assistive technology only.
    const name = screen.getByText('Project Kestrel', { exact: false });
    expect(name).toHaveClass('sr-only');
    expect(heading.textContent?.replace('Project Kestrel', '').trim()).toBe('Rail');
  });

  it('reads "Rail" alone when no deal name is given', () => {
    render(<RailHeader progress={PROGRESS} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('Rail');
  });

  it('gives the header buttons a 44px minimum height below sm', () => {
    render(<RailHeader progress={PROGRESS} actions={<button type="button">Add step</button>} />);
    const actions = screen.getByRole('button', { name: 'Add step' }).parentElement as HTMLElement;
    expect(actions).toHaveAttribute('data-rail-header-actions');
    expect(actions.className).toContain('[&_button]:min-h-11');
    expect(actions.className).toContain('sm:[&_button]:min-h-0');
  });
});
