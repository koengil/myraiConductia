/**
 * The fourth call site of the Markdown atom. The latest presearch memo is agent
 * markdown fetched on mount and rendered inside the disclosure, on the light
 * surface; before this it was a raw <pre>.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const latestPresearch = vi.fn();

vi.mock('@/lib/ignatious/client', () => ({
  latestPresearch: (...args: unknown[]) => latestPresearch(...args),
  startPresearch: vi.fn(),
  pollPresearch: vi.fn(),
  answerPresearch: vi.fn(),
  cancelPresearch: vi.fn(),
}));

import { PresearchRunner } from '@/components/leads/PresearchRunner';

const MEMO = '## Read\n\n| topic | read |\n|---|---|\n| price | firm |';

beforeEach(() => {
  latestPresearch.mockReset();
});

describe('PresearchRunner latest memo', () => {
  it('renders the stored memo as markdown on the light variant', async () => {
    latestPresearch.mockResolvedValue({ latest: { memo_md: MEMO } });
    const { container } = render(<PresearchRunner companyId="c1" companyName="Atlassian" />);

    await waitFor(() => expect(container.querySelector('table')).not.toBeNull());
    expect(container.querySelector('h2')?.textContent).toBe('Read');
    // The memo sits on a light surface, so it must not pick up the on-dark ink.
    const wrapper = container.querySelector('details > div') as HTMLElement;
    expect(wrapper.style.getPropertyValue('--md-ink')).toBe('var(--ink)');
  });

  it('shows no memo disclosure when the lead has never been presearched', async () => {
    latestPresearch.mockResolvedValue({ latest: null });
    const { container } = render(<PresearchRunner companyId="c1" companyName="Atlassian" />);

    await waitFor(() => expect(latestPresearch).toHaveBeenCalledWith('c1'));
    expect(container.querySelector('details')).toBeNull();
  });

  it('stays mounted when the memo lookup rejects', async () => {
    latestPresearch.mockRejectedValue(new Error('offline'));
    const { container } = render(<PresearchRunner companyId="c1" companyName="Atlassian" />);

    await waitFor(() => expect(latestPresearch).toHaveBeenCalled());
    expect(container.querySelector('section')).not.toBeNull();
    expect(container.querySelector('details')).toBeNull();
  });
});
