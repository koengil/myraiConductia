import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { TemplateChangeBanner, formatRevisionDate } from '@/components/rail/TemplateChangeBanner';
import { TEMPLATE_CHANGE_SET as TEMPLATE_CHANGE_FIXTURE, decided } from './templateChangeSetFixture';

describe('TemplateChangeBanner', () => {
  it('states the revision, author and pending count', () => {
    render(
      <TemplateChangeBanner changeSet={TEMPLATE_CHANGE_FIXTURE} pendingCount={3} onReview={vi.fn()} />,
    );
    const banner = screen.getByRole('status', { name: 'Template updated' });
    expect(banner).toHaveTextContent(
      'Standard sell-side moved to v4 on Sep 30, 2026 (Storm Duncan). 3 changes wait for your decision. Your rail stays as it is until you choose.',
    );
    expect(banner.textContent).not.toContain('—');
  });

  it('uses the singular for one change', () => {
    render(
      <TemplateChangeBanner changeSet={TEMPLATE_CHANGE_FIXTURE} pendingCount={1} onReview={vi.fn()} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('1 change waits for your decision.');
  });

  it('renders nothing once every change is accepted', () => {
    const accepted = decided(TEMPLATE_CHANGE_FIXTURE, {
      'added:custom-fairness': 'accepted',
      'added:custom-sanctions': 'accepted',
      'removed:p5-s53': 'accepted',
    });
    const { container } = render(
      <TemplateChangeBanner changeSet={accepted} pendingCount={0} onReview={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps a quiet way back to the decisions when nothing waits and something was discarded', () => {
    const onReview = vi.fn();
    const settled = decided(TEMPLATE_CHANGE_FIXTURE, {
      'added:custom-fairness': 'accepted',
      'added:custom-sanctions': 'discarded',
      'removed:p5-s53': 'accepted',
    });
    render(<TemplateChangeBanner changeSet={settled} pendingCount={0} onReview={onReview} />);

    const region = screen.getByRole('status', { name: 'Template decisions' });
    expect(region).toHaveTextContent('Standard sell-side · v4. No changes waiting.');
    expect(screen.queryByRole('status', { name: 'Template updated' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review decisions' }));
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it('counts a kept removal as a decision worth reopening', () => {
    const settled = decided(TEMPLATE_CHANGE_FIXTURE, {
      'added:custom-fairness': 'accepted',
      'added:custom-sanctions': 'accepted',
      'removed:p5-s53': 'discarded',
    });
    render(<TemplateChangeBanner changeSet={settled} pendingCount={0} onReview={vi.fn()} />);
    expect(screen.getByRole('status', { name: 'Template decisions' })).toBeInTheDocument();
  });

  it('opens the review from its button', () => {
    const onReview = vi.fn();
    render(
      <TemplateChangeBanner changeSet={TEMPLATE_CHANGE_FIXTURE} pendingCount={3} onReview={onReview} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it('formats revision dates in UTC', () => {
    expect(formatRevisionDate('2026-09-30T23:30:00.000Z')).toBe('Sep 30, 2026');
  });
});
