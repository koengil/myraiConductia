import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { EntryLine, entryLineText } from '@/components/rail/EntryLine';
import { firstStepAfterGate0, MVP_DEAL_RAIL, stepIdForSeq } from '@/lib/rail/dealRail';
import { activeSteps, railFromCatalog } from '@/lib/rail/projectRail';

/** The flag-off rail of a deal entered at `entryStepSeq`, cursor on the entry. */
function stepsEnteredAt(entryStepSeq: number) {
  return activeSteps(railFromCatalog(stepIdForSeq(entryStepSeq, MVP_DEAL_RAIL), entryStepSeq));
}

describe('EntryLine', () => {
  it('renders nothing when the deal opened at the first step after Gate 0', () => {
    const entry = firstStepAfterGate0();
    if (!entry) throw new Error('Expected a station after Gate 0');
    const { container } = render(
      <EntryLine steps={stepsEnteredAt(entry.seq)} entryStepSeq={entry.seq} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('names the step the deal opened at, on the rendered step scale', () => {
    render(<EntryLine steps={stepsEnteredAt(48)} entryStepSeq={48} />);
    expect(screen.getByTestId('rail-entry-line')).toHaveTextContent(
      'Opened at step 44 · LOI Review',
    );
  });

  it('renders nothing when the deal opened at entry 1', () => {
    const { container } = render(<EntryLine steps={stepsEnteredAt(1)} entryStepSeq={1} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the entry is not on the rail', () => {
    expect(entryLineText(stepsEnteredAt(48), 999)).toBeNull();
    expect(entryLineText(stepsEnteredAt(48), undefined)).toBeNull();
  });

  it('carries no em-dash', () => {
    for (const seq of [12, 20, 48, 60]) {
      const text = entryLineText(stepsEnteredAt(seq), seq);
      expect(text).not.toBeNull();
      expect(text).not.toContain('—');
    }
  });
});
