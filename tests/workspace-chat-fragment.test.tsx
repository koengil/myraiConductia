import * as React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * #331: the chat prompt rides in the URL fragment (`/chat#q=`), never the query
 * (`/chat?q=`), so the text a banker types is not in a request line or a log.
 * The /chat route is unmounted today (notFound()); these pin the components for
 * when it returns.
 */

const push = vi.hoisted(() => vi.fn());
const logAudit = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useParams: () => ({ projectId: 'proj-1' }),
  // The old Chat read ?q= from here. A query value must now be ignored.
  useSearchParams: () => new URLSearchParams('q=From+the+query'),
}));
vi.mock('@/lib/deals/useDeals', () => ({
  useActiveDeal: () => ({ codename: 'Project Atlas' }),
  // Chat reads the deal through useActiveDealState since #349 (#162).
  useActiveDealState: () => ({ deal: { codename: 'Project Atlas' }, unavailable: false, retry: () => undefined }),
}));
vi.mock('@/lib/audit/store', () => ({ logAudit }));

import { AskComposer } from '@/components/workspace/AskComposer';
import { Chat } from '@/components/workspace/Chat';
import { SuggestionChips } from '@/components/workspace/SuggestionChips';

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  // jsdom does not implement scrollIntoView; Chat scrolls to the latest turn.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('SuggestionChips', () => {
  it('links each prompt with #q= and never ?q=', () => {
    render(<SuggestionChips projectId="proj-1" />);
    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const href = link.getAttribute('href') ?? '';
      expect(href).toMatch(/^\/projects\/proj-1\/chat#q=/);
      expect(href).not.toContain('?q=');
      expect(href).not.toContain('&q=');
    }
    const teaser = screen.getByRole('link', { name: /Draft the teaser/ });
    expect(decodeURIComponent((teaser.getAttribute('href') ?? '').split('#q=')[1].replace(/\+/g, ' '))).toBe(
      'Draft the teaser',
    );
  });
});

describe('AskComposer', () => {
  it('pushes the question in the fragment, not the query', () => {
    render(<AskComposer projectId="proj-1" codename="Project Atlas" />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Which buyers & why?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(push).toHaveBeenCalledTimes(1);
    const href = push.mock.calls[0][0] as string;
    expect(href).toMatch(/^\/projects\/proj-1\/chat#q=/);
    expect(href).not.toContain('?q=');
    expect(href).not.toContain('&q=');
    // The ampersand is encoded: the question cannot add a parameter.
    expect(href).not.toContain('& ');
    expect(decodeURIComponent(href.split('#q=')[1].replace(/\+/g, ' '))).toBe('Which buyers & why?');
  });
});

describe('Chat', () => {
  it('seeds its first question from the fragment', () => {
    window.history.replaceState(null, '', '/projects/proj-1/chat#q=Draft+the+teaser');
    render(<Chat />);
    expect(screen.getByText('Draft the teaser')).toBeTruthy();
    expect(logAudit).toHaveBeenCalledWith('chat', 'Asked', 'Draft the teaser', { deal: 'Project Atlas' });
  });

  it('does not read the question from the query string', () => {
    window.history.replaceState(null, '', '/projects/proj-1/chat');
    render(<Chat />);
    expect(screen.queryByText('From the query')).toBeNull();
    expect(screen.getByText('Which buyers should we prioritize, and why?')).toBeTruthy();
  });
});
