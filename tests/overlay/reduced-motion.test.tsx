/**
 * prefers-reduced-motion: overlays keep the fade and drop all travel. Its own
 * file because Framer Motion reads the media query once per module instance.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { Dialog, Disclosure, Menu, Popover } from '@/components/overlay';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
});

describe('overlays under reduced motion', () => {
  it('Dialog fades in without the rise', () => {
    render(<Dialog open onClose={() => {}} title="Send" />);
    const panel = screen.getByRole('dialog');
    expect(panel.style.opacity).toBe('0');
    expect(panel.style.transform).not.toContain('translateY');
  });

  it('Menu fades in without the drop', () => {
    render(<Menu label="Row actions" items={[{ id: 'a', label: 'Rename', onSelect: () => {} }]} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Row actions' }), { key: 'Enter' });
    const menu = screen.getByRole('menu');
    expect(menu.style.transform).not.toContain('translateY');
  });

  it('Popover fades in without the drop', () => {
    render(
      <Popover
        open
        onOpenChange={() => {}}
        label="Notifications"
        trigger={(props) => <button type="button" {...props}>Bell</button>}
      >
        <p>Inbox</p>
      </Popover>,
    );
    const panel = screen.getByRole('dialog', { name: 'Notifications' });
    expect(panel.style.transform).not.toContain('translateY');
  });

  it('Disclosure opens without animating height', () => {
    render(
      <Disclosure title="Teaser">
        <p>Detail</p>
      </Disclosure>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Teaser' }));
    const panel = screen.getByText('Detail').closest('[data-disclosure-panel]') as HTMLElement;
    expect(panel.style.height).toBe('');
  });
});
