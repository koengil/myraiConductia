/**
 * The actions menu and simple picker (Radix DropdownMenu behind the Menu
 * props): roles, keys, Tab and outside close, focus return, portal.
 * Radix opens on keydown or pointerdown, not on a bare click.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { Disclosure, Menu, type MenuItem } from '@/components/overlay';

afterEach(cleanup);

function items(onSelect = vi.fn()): MenuItem[] {
  return [
    { id: 'rename', label: 'Rename', onSelect },
    { id: 'archive', label: 'Archive', onSelect, disabled: true },
    { id: 'remove', label: 'Remove from deal', onSelect, destructive: true },
  ];
}

function openWithKeyboard(name: string) {
  const trigger = screen.getByRole('button', { name });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return trigger;
}

describe('Menu', () => {
  it('names an icon-only trigger and opens a named menu on the first item', () => {
    render(<Menu label="Actions for Priya Mehta" items={items()} />);
    const trigger = screen.getByRole('button', { name: 'Actions for Priya Mehta' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    openWithKeyboard('Actions for Priya Mehta');
    const menu = screen.getByRole('menu', { name: 'Actions for Priya Mehta' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', menu.id);
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }));
  });

  it('opens on a pointer press too', () => {
    render(<Menu label="Row actions" items={items()} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Row actions' }), { button: 0, ctrlKey: false });
    expect(screen.getByRole('menu', { name: 'Row actions' })).toBeInTheDocument();
  });

  it('moves with the arrow keys (wrapping), Home and End, skipping disabled items', async () => {
    render(<Menu label="Row actions" items={items()} />);
    openWithKeyboard('Row actions');
    const rename = screen.getByRole('menuitem', { name: 'Rename' });
    const remove = screen.getByRole('menuitem', { name: 'Remove from deal' });
    // Radix moves roving focus on the next tick.
    const press = async (key: string, expected: HTMLElement) => {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key });
      await waitFor(() => expect(document.activeElement).toBe(expected));
    };
    await press('ArrowDown', remove);
    await press('ArrowDown', rename);
    await press('ArrowUp', remove);
    await press('Home', rename);
    await press('End', remove);
  });

  it('Escape closes and returns focus to the trigger', () => {
    render(<Menu label="Row actions" items={items()} />);
    const trigger = openWithKeyboard('Row actions');
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Rename' }), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('Tab closes and returns focus to the trigger', () => {
    render(<Menu label="Row actions" items={items()} />);
    const trigger = openWithKeyboard('Row actions');
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Rename' }), { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('choosing an item returns focus to the trigger before it runs', () => {
    const trigger = { focusedWhenRun: false };
    const onSelect = vi.fn(() => {
      trigger.focusedWhenRun =
        document.activeElement === screen.getByRole('button', { name: 'Row actions' });
    });
    render(<Menu label="Row actions" items={items(onSelect)} />);
    openWithKeyboard('Row actions');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(trigger.focusedWhenRun).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on an outside press', async () => {
    render(
      <>
        <Menu label="Row actions" items={items()} />
        <button type="button">Elsewhere</button>
      </>,
    );
    openWithKeyboard('Row actions');
    // Radix arms its outside-press listener a tick after opening.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('portals out of a clipping row, so a Disclosure panel cannot clip it', () => {
    render(
      <Disclosure title="Teaser" defaultOpen>
        <Menu label="Teaser actions" items={items()} />
      </Disclosure>,
    );
    openWithKeyboard('Teaser actions');
    const panel = document.querySelector('[data-disclosure-panel]') as HTMLElement;
    expect(panel.contains(screen.getByRole('menu'))).toBe(false);
  });

  it('becomes a picker when items carry checked, and the trigger keeps the menu name', () => {
    render(
      <Menu
        label="Sort by"
        trigger="Newest first"
        items={[
          { id: 'new', label: 'Newest first', checked: true, onSelect: () => {} },
          { id: 'old', label: 'Oldest first', checked: false, onSelect: () => {} },
        ]}
      />,
    );
    openWithKeyboard('Sort by: Newest first');
    expect(screen.getByRole('menuitemradio', { name: 'Newest first' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'Oldest first' })).toHaveAttribute('aria-checked', 'false');
  });

  it('shows an item description on a second line inside the item', () => {
    const onSelect = vi.fn();
    render(
      <Menu
        label="Skills for Acme"
        trigger="Run a skill"
        items={[
          { id: 'presearch', label: 'Presearch this lead', description: 'Research the company.', onSelect },
        ]}
      />,
    );
    openWithKeyboard('Skills for Acme: Run a skill');
    // Named by the label alone; the second line is its description.
    const item = screen.getByRole('menuitem', { name: 'Presearch this lead' });
    expect(item).toHaveAccessibleDescription('Research the company.');
    expect(item).toHaveTextContent('Research the company.');
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('keeps an item description visible on picker rows', () => {
    render(
      <Menu
        label="Sort by"
        trigger="Newest"
        items={[
          { id: 'new', label: 'Newest', description: 'Most recent first.', checked: true, onSelect: vi.fn() },
          { id: 'old', label: 'Oldest', checked: false, onSelect: vi.fn() },
        ]}
      />,
    );
    openWithKeyboard('Sort by: Newest');
    const row = screen.getByRole('menuitemradio', { name: 'Newest' });
    expect(row).toHaveAccessibleDescription('Most recent first.');
  });

  it('renders nothing with no items', () => {
    const { container } = render(<Menu label="Row actions" items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
