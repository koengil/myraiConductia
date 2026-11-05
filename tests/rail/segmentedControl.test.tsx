import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { SegmentedControl } from '@/components/atoms/SegmentedControl';

/* No aria-controls to a missing panel, and a selected state that reads in ink. */

const ITEMS = [
  { id: 'a', label: 'All' },
  { id: 'b', label: 'Mine' },
];

afterEach(cleanup);

describe('SegmentedControl', () => {
  it('emits no aria-controls when no panel id is passed', () => {
    render(<SegmentedControl items={ITEMS} value="a" onChange={() => {}} idBase="x" aria-label="View" />);
    for (const tab of screen.getAllByRole('tab')) expect(tab).not.toHaveAttribute('aria-controls');
  });

  it('emits aria-controls only for the panels that exist', () => {
    render(
      <SegmentedControl
        items={ITEMS}
        value="a"
        onChange={() => {}}
        idBase="x"
        aria-label="View"
        panelIdFor={(id) => (id === 'a' ? 'x-panel-a' : undefined)}
      />,
    );
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-controls', 'x-panel-a');
    expect(screen.getByRole('tab', { name: 'Mine' })).not.toHaveAttribute('aria-controls');
  });

  it('gives the selected tab ink text and a visible ink indicator; others none', () => {
    render(<SegmentedControl items={ITEMS} value="a" onChange={() => {}} idBase="x" aria-label="View" />);
    const selected = screen.getByRole('tab', { name: 'All' });
    expect(selected.className).toContain('text-[var(--ink)]');
    expect(selected.querySelector('[data-segment-indicator]')?.className).toContain('bg-[var(--ink)]');
    const other = screen.getByRole('tab', { name: 'Mine' });
    expect(other.querySelector('[data-segment-indicator]')?.className).toContain('opacity-0');
  });
});
