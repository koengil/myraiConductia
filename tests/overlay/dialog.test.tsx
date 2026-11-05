/**
 * The one Dialog: portal, naming, Escape, scrim, focus in/trap/return through
 * useModalDialog, exit motion that releases focus at once, and Menu-in-Dialog
 * Escape scoping. jsdom has no matchMedia here, so motion is on.
 */
import * as React from 'react';
import { flushSync } from 'react-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { AnimatePresence } from 'framer-motion';

import { Dialog, Menu, useRetainedWhileClosing } from '@/components/overlay';

afterEach(cleanup);

function Harness({
  dismissOnScrim,
  keepMounted = false,
  withMenu = false,
  ariaLabel,
}: {
  dismissOnScrim?: boolean;
  keepMounted?: boolean;
  withMenu?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const close = () => setOpen(false);
  const dialog = (
    <Dialog
      open={keepMounted ? open : true}
      onClose={close}
      title="Remove Priya Mehta"
      eyebrow="Team"
      description="She loses access to this deal."
      ariaLabel={ariaLabel}
      dismissOnScrim={dismissOnScrim}
      footer={
        <>
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="button">Remove</button>
        </>
      }
    >
      <input aria-label="Note" />
      {withMenu ? (
        <Menu label="Note actions" items={[{ id: 'clear', label: 'Clear note', onSelect: () => {} }]} />
      ) : null}
    </Dialog>
  );
  return (
    <div data-testid="host">
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {keepMounted ? dialog : open ? dialog : null}
    </div>
  );
}

function openIt() {
  const opener = screen.getByRole('button', { name: 'Open' });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

describe('Dialog', () => {
  it('portals a named, described modal dialog to document.body', () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).toBeNull();
    openIt();
    const dialog = screen.getByRole('dialog', { name: 'Remove Priya Mehta' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('She loses access to this deal.');
    expect(screen.getByTestId('host').contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Remove Priya Mehta');
    expect(within(dialog).getByText('Team')).toBeInTheDocument();
  });

  it('takes its accessible name from ariaLabel only when that escape hatch is set', () => {
    render(<Harness ariaLabel="Remove a member" />);
    openIt();
    expect(screen.getByRole('dialog', { name: 'Remove a member' })).toBeInTheDocument();
  });

  it('focuses the first body control, traps Tab, and Escape closes and returns focus', () => {
    render(<Harness />);
    const opener = openIt();
    const dialog = screen.getByRole('dialog');
    const note = within(dialog).getByRole('textbox', { name: 'Note' });
    expect(document.activeElement).toBe(note);

    // Tab order: close (header), Note, Cancel, Remove (mixed control types: document order), wrapping both ways.
    const close = within(dialog).getByRole('button', { name: 'Close' });
    const remove = within(dialog).getByRole('button', { name: 'Remove' });
    remove.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(remove);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('focuses the first footer action when the body holds no control', () => {
    function Confirm() {
      return (
        <Dialog
          open
          onClose={() => {}}
          title="Discard draft"
          footer={
            <>
              <button type="button">Keep editing</button>
              <button type="button">Discard</button>
            </>
          }
        />
      );
    }
    render(<Confirm />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep editing' }));
  });

  it('honours an explicit initialFocus', () => {
    function WithInitial() {
      const ref = React.useRef<HTMLButtonElement | null>(null);
      return (
        <Dialog
          open
          onClose={() => {}}
          title="Send"
          initialFocus={ref}
          footer={
            <>
              <button type="button">Cancel</button>
              <button ref={ref} type="button">
                Send
              </button>
            </>
          }
        />
      );
    }
    render(<WithInitial />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Send' }));
  });

  it('closes from the close button', () => {
    render(<Harness />);
    const opener = openIt();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes on a scrim click, not on a panel click, and not on a drag that ends on the scrim', () => {
    render(<Harness />);
    openIt();
    const dialog = screen.getByRole('dialog');
    const scrim = dialog.parentElement as HTMLElement;
    expect(scrim).toHaveAttribute('data-overlay-scrim');

    fireEvent.click(dialog);
    expect(screen.queryByRole('dialog')).not.toBeNull();

    fireEvent.mouseDown(dialog);
    fireEvent.click(scrim);
    expect(screen.queryByRole('dialog')).not.toBeNull();

    fireEvent.mouseDown(scrim);
    fireEvent.click(scrim);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ignores the scrim when dismissOnScrim is off, but Escape still closes', () => {
    render(<Harness dismissOnScrim={false} />);
    openIt();
    fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement);
    expect(screen.queryByRole('dialog')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('enters with an 8px rise when motion is allowed', () => {
    render(<Harness />);
    openIt();
    expect(screen.getByRole('dialog').style.transform).toContain('translateY(8px)');
  });

  it('kept mounted, plays its exit but hands focus back at once', async () => {
    render(<Harness keepMounted />);
    const opener = openIt();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.activeElement).toBe(opener);
    // Leaving: the scrim lets clicks through instead of closing again.
    const leaving = screen.queryByRole('dialog');
    if (leaving) expect((leaving.parentElement as HTMLElement).style.pointerEvents).toBe('none');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('lets Escape close a Menu inside it without closing the Dialog', () => {
    render(<Harness withMenu />);
    openIt();
    const trigger = screen.getByRole('button', { name: 'Note actions' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const menu = screen.getByRole('menu', { name: 'Note actions' });
    // Portalled into the panel, so it stays inside the aria-modal dialog.
    expect(screen.getByRole('dialog').contains(menu)).toBe(true);
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Clear note' }), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it('stops a Menu Escape before it reaches the window, whatever React does after', () => {
    // In a browser, Radix closes the menu from a document capture listener and
    // React can unmount the menu before the event bubbles, so a React
    // onKeyDown never runs. The menu must stop the native event at capture.
    render(<Harness withMenu />);
    openIt();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Note actions' }), { key: 'Enter' });
    // Emulate the browser's microtask checkpoint after Radix's listener: flush
    // React, so the menu is gone before the event bubbles.
    const checkpoint = () => flushSync(() => {});
    const reachedWindow = vi.fn();
    document.addEventListener('keydown', checkpoint, { capture: true });
    window.addEventListener('keydown', reachedWindow);
    try {
      fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Clear note' }), { key: 'Escape' });
    } finally {
      document.removeEventListener('keydown', checkpoint, { capture: true });
      window.removeEventListener('keydown', reachedWindow);
    }
    expect(reachedWindow).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('useRetainedWhileClosing', () => {
  it('keeps the last record after the value clears', () => {
    function Probe({ value }: { value: string | null }) {
      const shown = useRetainedWhileClosing(value);
      return <p>{shown ?? 'none'}</p>;
    }
    const { rerender } = render(<Probe value={null} />);
    expect(screen.getByText('none')).toBeInTheDocument();
    rerender(<Probe value="Priya Mehta" />);
    rerender(<Probe value={null} />);
    expect(screen.getByText('Priya Mehta')).toBeInTheDocument();
    rerender(<Probe value="Rob Admin" />);
    expect(screen.getByText('Rob Admin')).toBeInTheDocument();
  });
});

describe('Dialog mounted conditionally under AnimatePresence', () => {
  function Conditional({ show, open = true }: { show: boolean; open?: boolean }) {
    return (
      <AnimatePresence>
        {show ? (
          <Dialog key="d" open={open} onClose={() => {}} title="Rename this proposed deal">
            <input aria-label="Name" />
          </Dialog>
        ) : null}
      </AnimatePresence>
    );
  }

  it('plays its exit when the parent removes it, then leaves', async () => {
    const { rerender } = render(<Conditional show />);
    expect(screen.getByRole('dialog', { name: 'Rename this proposed deal' })).toBeInTheDocument();
    rerender(<Conditional show={false} />);
    // Still on screen while the exit runs, then gone.
    expect(screen.getByRole('dialog', { name: 'Rename this proposed deal' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('releases the parent at once when it was already closed', async () => {
    const { rerender, container } = render(<Conditional show open={false} />);
    rerender(<Conditional show={false} open={false} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
