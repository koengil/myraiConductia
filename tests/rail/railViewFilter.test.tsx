import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { RailViewFilter } from '@/components/rail/RailViewFilter';

afterEach(cleanup);

describe('RailViewFilter', () => {
  it('says activity could not be loaded, with a retry, when the read failed', () => {
    const retry = vi.fn();
    render(<RailViewFilter value={['has_activity']} onChange={() => {}} activityFailed onRetryActivity={retry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Activity could not be loaded.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('applies the ticked views only on Apply, and drops an unapplied choice on closing', () => {
    const onChange = vi.fn();
    render(<RailViewFilter value={[]} onChange={onChange} counts={{ all: 9, mine: 2, unassigned: 3 }} shownCount={9} />);
    const trigger = screen.getByRole('button', { name: /^Show: All/ });

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('checkbox', { name: /^Mine/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^Unassigned/ }));
    expect(screen.getByRole('checkbox', { name: /^All/ })).not.toBeChecked();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.getByRole('checkbox', { name: /^Mine/ })).not.toBeChecked();

    fireEvent.click(screen.getByRole('checkbox', { name: /^Open/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onChange).toHaveBeenCalledWith(['open']);
    expect(screen.queryByRole('dialog', { name: 'Show' })).not.toBeInTheDocument();
  });

  it('says nothing about a failure when the read is good', () => {
    render(<RailViewFilter value={[]} onChange={() => {}} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
