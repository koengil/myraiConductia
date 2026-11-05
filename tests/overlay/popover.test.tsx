/**
 * The non-modal panel (Popover): named, wired to its trigger, no focus trap,
 * Escape returns focus to the trigger when focus is inside, an outside press
 * or Tab out closes it, and inside a Dialog one Escape closes only the Popover.
 */
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { Dialog, Popover } from '@/components/overlay';
import { SidebarDealSelect } from '@/components/deals/DealSelect';
import type { FixtureDeal } from '@/lib/rail/deals';

afterEach(cleanup);

function Harness() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        label="Notifications"
        trigger={(props) => (
          <button type="button" {...props} aria-label="Bell">
            Bell
          </button>
        )}
      >
        <a href="/inbox">Open inbox</a>
        <button type="button">Mark read</button>
      </Popover>
      <button type="button">Outside</button>
    </>
  );
}

function openPanel() {
  const trigger = screen.getByRole('button', { name: 'Bell' });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

describe('Popover', () => {
  it('opens a named non-modal panel wired to its trigger', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Bell' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    openPanel();
    const panel = screen.getByRole('dialog', { name: 'Notifications' });
    expect(panel).not.toHaveAttribute('aria-modal');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', panel.id);
    // The panel follows its trigger, so Tab goes from the trigger into it.
    expect(trigger.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('Escape closes it and returns focus to the trigger', () => {
    render(<Harness />);
    const trigger = openPanel();
    screen.getByRole('button', { name: 'Mark read' }).focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('an outside press closes it where the user is', () => {
    render(<Harness />);
    openPanel();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a press inside keeps it open', () => {
    render(<Harness />);
    openPanel();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Mark read' }));
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('focus leaving the panel closes it (no focus trap)', () => {
    render(<Harness />);
    openPanel();
    act(() => screen.getByRole('link', { name: 'Open inbox' }).focus());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    act(() => screen.getByRole('button', { name: 'Outside' }).focus());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the trigger toggles it closed', () => {
    render(<Harness />);
    const trigger = openPanel();
    fireEvent.click(trigger);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape with focus outside the panel closes it and leaves focus where it is', () => {
    // Opened by its owner while focus sits elsewhere (no focus moved, so the
    // focus-out close never ran): Escape closes it, never pulling focus back.
    function Controlled() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <Popover
            open={open}
            onOpenChange={setOpen}
            label="Notifications"
            trigger={(props) => (
              <button type="button" {...props} aria-label="Bell">
                Bell
              </button>
            )}
          >
            <button type="button">Mark read</button>
          </Popover>
          <button type="button" onClick={() => setOpen(true)}>
            Show notifications
          </button>
        </>
      );
    }
    render(<Controlled />);
    const elsewhere = screen.getByRole('button', { name: 'Show notifications' });
    elsewhere.focus();
    fireEvent.click(elsewhere);
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeInTheDocument();
    fireEvent.keyDown(elsewhere, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Bell' }));
  });

  it('inside a Dialog, one Escape closes only the Popover and returns focus to its trigger', () => {
    function InDialog() {
      const [dialogOpen, setDialogOpen] = React.useState(true);
      const [open, setOpen] = React.useState(false);
      return dialogOpen ? (
        <Dialog open onClose={() => setDialogOpen(false)} title="Deal settings">
          <input aria-label="Name" />
          <Popover
            open={open}
            onOpenChange={setOpen}
            label="Who can see this"
            trigger={(props) => (
              <button type="button" {...props}>
                Visibility
              </button>
            )}
          >
            <button type="button">Bank only</button>
          </Popover>
        </Dialog>
      ) : null;
    }
    render(<InDialog />);
    const trigger = screen.getByRole('button', { name: 'Visibility' });
    trigger.focus();
    fireEvent.click(trigger);
    const inner = screen.getByRole('button', { name: 'Bank only' });
    act(() => inner.focus());
    fireEvent.keyDown(inner, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Who can see this' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Deal settings' })).toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
    // A second Escape, with no Popover open, closes the Dialog.
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Deal settings' })).toBeNull();
  });

  it('does not intercept Tab: the panel follows its trigger in tab order, and stays open as focus moves between them', () => {
    // jsdom does not move focus on Tab, so the helper moves it by hand to the
    // next tabbable element in document order. What this proves: the Popover
    // does not handle (preventDefault) Tab on the trigger or its first control,
    // the panel's first control is the next tabbable after the trigger, and
    // focus moving between them keeps the panel open.
    render(<Harness />);
    const trigger = openPanel();
    const panel = screen.getByRole('dialog', { name: 'Notifications' });
    const first = screen.getByRole('link', { name: 'Open inbox' });

    const forward = tab(trigger, false);
    expect(forward).toBe(first);
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeInTheDocument();

    const back = tab(first, true);
    expect(back).toBe(trigger);
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeInTheDocument();
  });
});

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Presses Tab (or Shift+Tab) on `from`; unless something handled it, focus
 * moves to the next tabbable in document order.
 */
function tab(from: HTMLElement, shift: boolean): Element | null {
  const handled = !fireEvent.keyDown(from, { key: 'Tab', shiftKey: shift });
  if (!handled) {
    const order = Array.from(document.querySelectorAll<HTMLElement>(TABBABLE));
    const next = order[order.indexOf(from) + (shift ? -1 : 1)];
    if (next) act(() => next.focus());
  }
  return document.activeElement;
}

describe('deal switcher panel', () => {
  const deals = [
    { id: 'd1', code: 'SUMMIT-1', codename: 'Project Summit', cursorStepId: 'p1-s1' },
  ] as unknown as FixtureDeal[];

  it('"New deal" is a plain button that returns focus to the switcher before the dialog opens', () => {
    let focusedAtOpen: Element | null = null;
    render(
      <SidebarDealSelect
        deals={deals}
        activeId="d1"
        onSelect={() => {}}
        menuFooter={{
          showNewDeal: true,
          onNewDeal: () => {
            focusedAtOpen = document.activeElement;
          },
        }}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Deal: Project Summit. Switch deal' });
    fireEvent.click(trigger);
    const panel = screen.getByRole('dialog', { name: 'Switch deal' });
    expect(screen.queryByRole('menuitem')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New deal' }));
    expect(focusedAtOpen).toBe(trigger);
    expect(panel).not.toBeInTheDocument();
  });
});
