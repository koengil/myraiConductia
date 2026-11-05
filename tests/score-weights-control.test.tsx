import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as React from 'react';

import { ScoreWeightsControl } from '../src/components/acquirers/ScoreWeightsControl';
import { DEFAULT_WEIGHTS, type ScoreWeights } from '../src/lib/scoring/composite';

/**
 * Per-component tests for the bucket-weights slider (Phase C sandbox merge,
 * ADR-0002). The control is purely controlled — its parent owns the weights
 * state. These tests cover the controlled-component contract: default
 * display, slider input → onWeightsChange with the auto-balanced pair, and
 * the Reset affordance.
 */

function renderAt(initial: ScoreWeights = DEFAULT_WEIGHTS) {
  const onWeightsChange = vi.fn();
  const utils = render(
    <ScoreWeightsControl
      weights={initial}
      onWeightsChange={onWeightsChange}
      surface="light"
    />,
  );
  return { ...utils, onWeightsChange };
}

describe('ScoreWeightsControl', () => {
  it('renders both bucket sliders with default 55 / 45 percentages', () => {
    renderAt();

    const financial = screen.getByLabelText('Financial bucket weight') as HTMLInputElement;
    const culture = screen.getByLabelText(
      'Culture and strategic bucket weight',
    ) as HTMLInputElement;

    expect(financial.value).toBe('55');
    expect(culture.value).toBe('45');
    expect(screen.getByText('55%')).toBeInTheDocument();
    expect(screen.getByText('45%')).toBeInTheDocument();
  });

  it('moving the financial slider auto-balances culture and calls onWeightsChange', () => {
    const { onWeightsChange } = renderAt();
    const financial = screen.getByLabelText('Financial bucket weight');

    fireEvent.change(financial, { target: { value: '80' } });

    expect(onWeightsChange).toHaveBeenCalledTimes(1);
    expect(onWeightsChange).toHaveBeenLastCalledWith({
      financial: 80,
      culture: 20,
    });
  });

  it('moving the culture slider auto-balances financial', () => {
    const { onWeightsChange } = renderAt();
    const culture = screen.getByLabelText('Culture and strategic bucket weight');

    fireEvent.change(culture, { target: { value: '100' } });

    expect(onWeightsChange).toHaveBeenLastCalledWith({
      financial: 0,
      culture: 100,
    });
  });

  it('Reset button is disabled at default weights', () => {
    renderAt();
    const reset = screen.getByRole('button', { name: 'Reset' });
    expect(reset).toBeDisabled();
  });

  it('Reset button is enabled after a slider change and dispatches DEFAULT_WEIGHTS', () => {
    const { onWeightsChange } = renderAt({ financial: 80, culture: 20 });
    const reset = screen.getByRole('button', { name: 'Reset' });

    expect(reset).not.toBeDisabled();
    fireEvent.click(reset);

    expect(onWeightsChange).toHaveBeenLastCalledWith(DEFAULT_WEIGHTS);
  });

  it('clamps slider input outside the 0-100 range', () => {
    const { onWeightsChange } = renderAt();
    const financial = screen.getByLabelText('Financial bucket weight');

    // Native <input type="range"> already clamps, but the component also
    // clamps defensively in setBucket. Drive the change event with an
    // out-of-range value to verify.
    fireEvent.change(financial, { target: { value: '150' } });
    expect(onWeightsChange).toHaveBeenLastCalledWith({
      financial: 100,
      culture: 0,
    });

    fireEvent.change(financial, { target: { value: '-5' } });
    expect(onWeightsChange).toHaveBeenLastCalledWith({
      financial: 0,
      culture: 100,
    });
  });
});
