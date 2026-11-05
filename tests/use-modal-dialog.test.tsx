import * as React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { useModalDialog } from '../src/lib/ui/useModalDialog';

function Dialog({ label, onClose, children }: { label: string; onClose: () => void; children?: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  useModalDialog(ref, onClose);
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={label}>
      <button type="button">{label} first</button>
      <button type="button">{label} last</button>
      {children}
    </div>
  );
}

function Harness({ onClose, onInnerClose, inner = false }: { onClose: () => void; onInnerClose?: () => void; inner?: boolean }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      {open ? (
        <Dialog label="Outer" onClose={() => { onClose(); setOpen(false); }}>
          {inner ? <Dialog label="Inner" onClose={onInnerClose ?? (() => {})} /> : null}
        </Dialog>
      ) : null}
    </>
  );
}

afterEach(cleanup);

describe('useModalDialog (#250)', () => {
  it('focuses in, wraps Tab both ways, closes on Escape and restores focus', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);

    const first = screen.getByRole('button', { name: 'Outer first' });
    const last = screen.getByRole('button', { name: 'Outer last' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    opener.focus(); // focus escaped the dialog somehow
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('keeps a native disclosure summary in the Tab cycle', () => {
    render(
      <Dialog label="Memo" onClose={() => {}}>
        <details>
          <summary>Latest memo</summary>
          <p>No links here.</p>
        </details>
      </Dialog>,
    );
    const summary = screen.getByText('Latest memo');
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(summary);
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Memo first' }));
  });

  it('lets only the innermost dialog answer Escape', () => {
    const onClose = vi.fn();
    const onInnerClose = vi.fn();
    render(<Harness onClose={onClose} onInnerClose={onInnerClose} inner />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Inner first' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onInnerClose).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('leaves Escape alone when a layer inside the dialog already handled it', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    // A nested menu or listbox handles Escape first, as Radix does from a
    // document capture listener, and marks it handled.
    const handled = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener('keydown', handled, { capture: true });
    try {
      fireEvent.keyDown(screen.getByRole('button', { name: 'Outer first' }), { key: 'Escape' });
    } finally {
      document.removeEventListener('keydown', handled, { capture: true });
    }
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Outer' })).toBeInTheDocument();
  });
});

