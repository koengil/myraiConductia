/** Inline record detail: aria-expanded rows and the single-open accordion. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { Disclosure, DisclosureGroup } from '@/components/overlay';

afterEach(cleanup);

describe('Disclosure', () => {
  it('expands under its row and wires aria-expanded and aria-controls', async () => {
    render(
      <Disclosure title="Teaser" meta="Oct 7, 2026">
        <p>Sent to 12 buyers.</p>
      </Disclosure>,
    );
    const row = screen.getByRole('button', { name: /Teaser/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Sent to 12 buyers.')).toBeNull();

    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    const detail = screen.getByText('Sent to 12 buyers.');
    expect(row).toHaveAttribute('aria-controls', detail.closest('[data-disclosure-panel]')?.id);

    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(screen.queryByText('Sent to 12 buyers.')).toBeNull());
  });

  it('starts open with defaultOpen and reports changes when controlled', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <Disclosure title="Teaser" defaultOpen>
        <p>Detail</p>
      </Disclosure>,
    );
    expect(screen.getByText('Detail')).toBeInTheDocument();

    rerender(
      <Disclosure title="Teaser" open={false} onOpenChange={onOpenChange}>
        <p>Detail</p>
      </Disclosure>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Teaser' }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});

describe('Disclosure actions and clipping', () => {
  it('renders actions beside the header button, never inside it', () => {
    render(
      <Disclosure title="Teaser" meta="Oct 7, 2026" actions={<button type="button">Rename</button>}>
        <p>Detail</p>
      </Disclosure>,
    );
    const row = screen.getByRole('button', { name: /Teaser/ });
    const action = screen.getByRole('button', { name: 'Rename' });
    expect(row.contains(action)).toBe(false);
    expect(row).toHaveAccessibleName(/^Teaser\s*Oct 7, 2026$/);
  });

  it('clips only while animating: a settled open panel does not hide overflow', async () => {
    render(
      <Disclosure title="Teaser">
        <p>Detail</p>
      </Disclosure>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Teaser' }));
    const panel = screen.getByText('Detail').closest('[data-disclosure-panel]') as HTMLElement;
    await waitFor(() => expect(panel).not.toHaveClass('overflow-hidden'));
  });
});

describe('DisclosureGroup', () => {
  function Rows({ single }: { single?: boolean }) {
    return (
      <DisclosureGroup single={single} defaultOpen={['teaser']}>
        <Disclosure value="teaser" title="Teaser">
          <p>Teaser detail</p>
        </Disclosure>
        <Disclosure value="nda" title="NDA">
          <p>NDA detail</p>
        </Disclosure>
      </DisclosureGroup>
    );
  }

  it('single: opening one row closes the open one', () => {
    render(<Rows single />);
    const teaser = screen.getByRole('button', { name: 'Teaser' });
    const nda = screen.getByRole('button', { name: 'NDA' });
    expect(teaser).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(nda);
    expect(nda).toHaveAttribute('aria-expanded', 'true');
    expect(teaser).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(nda);
    expect(nda).toHaveAttribute('aria-expanded', 'false');
    expect(teaser).toHaveAttribute('aria-expanded', 'false');
  });

  it('multiple: rows open independently', () => {
    render(<Rows />);
    fireEvent.click(screen.getByRole('button', { name: 'NDA' }));
    expect(screen.getByRole('button', { name: 'Teaser' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'NDA' })).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('Disclosure leading slot', () => {
  it('renders a leading control beside the header button, never inside it', () => {
    const onChange = vi.fn();
    render(
      <Disclosure title="Alex Reyes" leading={<input type="checkbox" aria-label="Select Alex Reyes" onChange={onChange} />}>
        <p>Detail</p>
      </Disclosure>,
    );
    const header = screen.getByRole('button', { name: 'Alex Reyes' });
    const checkbox = screen.getByRole('checkbox', { name: 'Select Alex Reyes' });
    expect(header.contains(checkbox)).toBe(false);
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(header).toHaveAttribute('aria-expanded', 'false');
  });
});
