/** The honest-preview markers carry the agreed copy verbatim. */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { PREVIEW_COPY, PreviewBanner, PreviewChip } from '@/components/overlay';

describe('PreviewChip', () => {
  it('reads "Preview" and describes itself as not saved yet', () => {
    const { container } = render(<PreviewChip />);
    const chip = container.querySelector('[data-preview="chip"]') as HTMLElement;
    expect(screen.getByText('Preview')).toBeInTheDocument();
    expect(chip).toHaveAttribute('title', 'Not saved yet. Engineers are wiring this.');
    expect(chip.textContent).toBe('Preview Not saved yet. Engineers are wiring this.');
  });
});

describe('PreviewBanner', () => {
  it('says only you see it and nothing is saved, with no Reset by default', () => {
    const { container } = render(<PreviewBanner />);
    expect(container.querySelector('[data-preview="banner"] p')?.textContent).toBe(
      'Preview. Only you see this. Nothing here is saved to the deal.',
    );
    expect(PREVIEW_COPY.banner).toBe('Preview. Only you see this. Nothing here is saved to the deal.');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers Reset when given onReset', () => {
    const onReset = vi.fn();
    render(<PreviewBanner onReset={onReset} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
