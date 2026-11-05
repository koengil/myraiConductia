import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PartyColumn } from '@/components/team/PartyColumn';

describe('PartyColumn count', () => {
  it('reads "1 person" for one and "N people" otherwise', () => {
    const { rerender } = render(<PartyColumn label="Sellers" count={1}>{null}</PartyColumn>);
    expect(screen.getByText('1 person')).toBeInTheDocument();
    expect(screen.queryByText('1 people')).toBeNull();
    rerender(<PartyColumn label="Sellers" count={3}>{null}</PartyColumn>);
    expect(screen.getByText('3 people')).toBeInTheDocument();
  });

  it('the visible count uses readable ink, never the decoration-only --ink-quiet', () => {
    render(<PartyColumn label="Sellers" count={3}>{null}</PartyColumn>);
    const visible = screen.getByText('3', { selector: '[aria-hidden="true"]' });
    const wrapper = visible.parentElement!;
    expect(wrapper.className).toContain('text-[var(--ink-tertiary)]');
    expect(wrapper.className).not.toContain('--ink-quiet');
  });
});
