import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { EntryStepSelect } from '../../src/components/deals/EntryStepSelect';
import { GATE0_STEP_IDS } from '../../src/lib/rail/gate0';
import { MVP_DEAL_RAIL, orderedSteps } from '../../src/lib/rail/dealRail';

afterEach(cleanup);

const STATIONS = orderedSteps(MVP_DEAL_RAIL).slice(GATE0_STEP_IDS.length);

describe('EntryStepSelect', () => {
  it('labels each step with its padded number and title, and carries the seq as the value', () => {
    render(<EntryStepSelect steps={STATIONS} value={STATIONS[0].seq} onChange={() => {}} />);

    const select = screen.getByRole('combobox', { name: 'Starting step' });
    expect(select).toHaveValue(String(STATIONS[0].seq));
    const first = screen.getByRole('option', { name: '04 · Relationship Pathing' });
    expect(first).toHaveValue(String(STATIONS[0].seq));
    const loi = screen.getByRole('option', { name: '44 · LOI Review' });
    expect(loi).toHaveValue('48');
    expect(screen.getAllByRole('option')).toHaveLength(STATIONS.length);
  });

  it('reports the chosen seq as a number', () => {
    const onChange = vi.fn();
    render(<EntryStepSelect steps={STATIONS} value={STATIONS[0].seq} onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Starting step' }), { target: { value: '48' } });
    expect(onChange).toHaveBeenCalledWith(48);
  });

  it('honours the disabled state and a custom label', () => {
    render(
      <EntryStepSelect
        steps={STATIONS}
        value={STATIONS[0].seq}
        onChange={() => {}}
        disabled
        label="Opens at"
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Opens at' })).toBeDisabled();
  });

  it('starts unpicked on the placeholder when no station is chosen, and drops it once one is', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <EntryStepSelect steps={STATIONS} value={null} onChange={onChange} placeholder="Choose a step" />,
    );
    const select = screen.getByRole('combobox', { name: 'Starting step' });
    expect(select).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Choose a step' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: '48' } });
    expect(onChange).toHaveBeenCalledWith(48);
    rerender(<EntryStepSelect steps={STATIONS} value={48} onChange={onChange} placeholder="Choose a step" />);
    expect(screen.queryByRole('option', { name: 'Choose a step' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Starting step' })).toHaveValue('48');
  });
});
