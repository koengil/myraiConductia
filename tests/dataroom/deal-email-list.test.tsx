import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { DealEmailList } from '@/components/dataroom/DealEmailList';

type Row = {
  sourceItemId: string;
  sentDay: string | null;
  fromDomain: string | null;
  sender: string | null;
  subject: string | null;
  own: boolean;
  opensThread: boolean;
};

const OWN: Row = {
  sourceItemId: 'i-own',
  sentDay: '2026-09-18',
  fromDomain: 'northwind-robotics.example',
  sender: 'Mike Cannon',
  subject: 'Project Kestrel: LOI signed',
  own: true,
  opensThread: true,
};
const TEAM: Row = {
  sourceItemId: 'i-team',
  sentDay: '2026-09-17',
  fromDomain: 'northwind-robotics.example',
  sender: 'Pat CFO',
  subject: 'Team inbox subject',
  own: true,
  opensThread: false,
};
const OTHER: Row = {
  sourceItemId: 'i-other',
  sentDay: '2026-09-19',
  fromDomain: 'northwind-robotics.example',
  sender: null,
  subject: null,
  own: false,
  opensThread: false,
};

function respond(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DealEmailList', () => {
  it('asks the deal-email route for this deal, encoding the code', async () => {
    const fetchMock = respond({ items: [], truncated: false });
    render(<DealEmailList dealCode="ATLAS 2026/001" />);
    await screen.findByText('No linked email you can read on this deal.');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/discovery/deal-email?deal=ATLAS%202026%2F001', expect.anything());
  });

  it('shows sender and subject for own mail and the metadata-only line for a colleague\'s', async () => {
    respond({ items: [OTHER, OWN], truncated: false });
    render(<DealEmailList dealCode="KESTR-2026-412" />);
    expect(await screen.findByText('Mike Cannon')).toBeInTheDocument();
    expect(screen.getByText(/Project Kestrel: LOI signed/)).toBeInTheDocument();
    expect(screen.getByText('Sep 18, 2026')).toBeInTheDocument();
    expect(screen.getByText('Sep 19, 2026')).toBeInTheDocument();
    expect(screen.getAllByText('northwind-robotics.example')).toHaveLength(2);
    expect(screen.getByText("From another banker's mailbox · metadata only")).toBeInTheDocument();
    expect(screen.getByText('2 messages')).toBeInTheDocument();
  });

  it('never renders a subject the server did not send for a colleague\'s row', async () => {
    // A server that wrongly sent a subject on a non-own row would still not be shown by the list.
    respond({ items: [{ ...OTHER, subject: 'Secret colleague subject', sender: 'Pat CFO' }], truncated: false });
    const { container } = render(<DealEmailList dealCode="KESTR-2026-412" />);
    await screen.findByText("From another banker's mailbox · metadata only");
    expect(container.textContent).not.toContain('Secret colleague subject');
    expect(container.textContent).not.toContain('Pat CFO');
  });

  it('says so in one sentence when nothing is readable', async () => {
    respond({ items: [], truncated: false });
    render(<DealEmailList dealCode="KESTR-2026-412" />);
    expect(await screen.findByText('No linked email you can read on this deal.')).toBeInTheDocument();
    expect(screen.getByText('0 messages')).toBeInTheDocument();
  });

  it('notes the cap only when the list was truncated', async () => {
    respond({ items: [OWN], truncated: true });
    render(<DealEmailList dealCode="KESTR-2026-412" />);
    expect(await screen.findByText('Showing the 200 most recent.')).toBeInTheDocument();
    expect(screen.getByText('1 message')).toBeInTheDocument();
    cleanup();
    respond({ items: [OWN], truncated: false });
    render(<DealEmailList dealCode="KESTR-2026-412" />);
    await screen.findByText('Mike Cannon');
    expect(screen.queryByText('Showing the 200 most recent.')).not.toBeInTheDocument();
  });

  it('writes a missing day, domain and subject plainly', async () => {
    respond({ items: [{ ...OWN, sentDay: null, fromDomain: null, subject: '' }], truncated: false });
    render(<DealEmailList dealCode="KESTR-2026-412" />);
    expect(await screen.findByText('Undated')).toBeInTheDocument();
    expect(screen.getByText('Unknown domain')).toBeInTheDocument();
    expect(screen.getByText(/\(no subject\)/)).toBeInTheDocument();
  });

  it('maps a signed-out answer the way the documents do; no status here means not on the deal', async () => {
    respond({ error: 'Unauthorized' }, 401);
    render(<DealEmailList dealCode="KESTR-2026-412" />);
    expect(await screen.findByRole('heading', { name: 'Your session has ended' })).toBeInTheDocument();
    cleanup();
    // The route answers a non-member with an empty list. Its 403 is an
    // account gate and its 404 the flag gate: each is a failed read.
    for (const status of [403, 404]) {
      respond({ error: 'Forbidden' }, status);
      render(<DealEmailList dealCode="KESTR-2026-412" />);
      expect(await screen.findByRole('alert')).toHaveTextContent('The deal email failed to load.');
      expect(screen.queryByText('You are not on this deal.')).not.toBeInTheDocument();
      expect(screen.queryByText('Your seat does not cover this deal')).not.toBeInTheDocument();
      cleanup();
    }
  });

  it('states a failed load and a network error', async () => {
    respond({ error: 'Could not load the deal email' }, 500);
    render(<DealEmailList dealCode="KESTR-2026-412" />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The deal email failed to load.');
    expect(alert).not.toHaveTextContent('Could not load the deal email');
    cleanup();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(<DealEmailList dealCode="KESTR-2026-412" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Network error');
  });

  it('uses no em-dash or en-dash in its visible copy', async () => {
    respond({ items: [OTHER, OWN, { ...OWN, sourceItemId: 'x', sentDay: null }], truncated: true });
    const { container } = render(<DealEmailList dealCode="KESTR-2026-412" />);
    await screen.findByText('Showing the 200 most recent.');
    expect(container.textContent).not.toMatch(/[–—]/);
  });

  describe('opening a thread (#339)', () => {
    const THREAD = {
      conversationId: 'rfc822:<root@northwind.example>',
      messages: [
        {
          sourceItemId: 'i-own',
          sentAt: '2026-09-18T15:00:00Z',
          from: { address: 'mike@northwind.example', name: 'Mike Cannon' },
          to: [{ address: 'storm@bank.example', name: 'Storm Duncan' }],
          cc: [{ address: 'pat@northwind.example', name: null }],
          subject: 'Project Kestrel: LOI signed',
          body: 'We signed the LOI.\nNext: diligence.',
          internetMessageId: '<a@northwind.example>',
        },
      ],
    };

    function route(thread: { status: number; body: unknown }) {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.startsWith('/api/v1/discovery/deal-email/thread')) {
          return { ok: thread.status === 200, status: thread.status, json: async () => thread.body };
        }
        return { ok: true, status: 200, json: async () => ({ items: [OTHER, TEAM, OWN], truncated: false }) };
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    // A team inbox item (PR #614) shows its sender and subject to a member, but its thread does not open.
    it("makes only the reader's own mailbox rows controls, not a team inbox row", async () => {
      route({ status: 200, body: THREAD });
      render(<DealEmailList dealCode="KESTR-2026-412" />);
      await screen.findByText('Mike Cannon');
      expect(screen.getByText(/Team inbox subject/)).toBeInTheDocument();
      const buttons = screen.getAllByRole('button');
      expect(buttons).toHaveLength(1);
      expect(buttons[0]).toHaveTextContent('Project Kestrel: LOI signed');
    });

    it('opens the thread from the route, shows bodies and addresses, and goes back to the list', async () => {
      const fetchMock = route({ status: 200, body: THREAD });
      render(<DealEmailList dealCode="KESTR 2026/412" />);
      fireEvent.click(await screen.findByRole('button', { name: /Project Kestrel: LOI signed/ }));
      expect(await screen.findByText(/We signed the LOI\./)).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/discovery/deal-email/thread?deal=KESTR%202026%2F412&item=i-own',
        expect.anything(),
      );
      expect(screen.getByRole('heading', { name: 'Project Kestrel: LOI signed' })).toBeInTheDocument();
      expect(screen.getByText('Mike Cannon <mike@northwind.example>')).toBeInTheDocument();
      expect(screen.getByText('To: Storm Duncan <storm@bank.example>')).toBeInTheDocument();
      expect(screen.getByText('Cc: pat@northwind.example')).toBeInTheDocument();
      expect(screen.getByText('Sep 18, 2026, 3:00 PM UTC')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Back to deal email' }));
      expect(await screen.findByText("From another banker's mailbox · metadata only")).toBeInTheDocument();
    });

    it('says the thread is no longer available on a 404, and that it failed on anything else', async () => {
      route({ status: 404, body: { error: 'Not found' } });
      render(<DealEmailList dealCode="KESTR-2026-412" />);
      fireEvent.click(await screen.findByRole('button', { name: /Project Kestrel/ }));
      expect(await screen.findByRole('alert')).toHaveTextContent('This thread is no longer available to you.');
      cleanup();
      route({ status: 500, body: { error: 'Could not load the thread' } });
      render(<DealEmailList dealCode="KESTR-2026-412" />);
      fireEvent.click(await screen.findByRole('button', { name: /Project Kestrel/ }));
      expect(await screen.findByRole('alert')).toHaveTextContent('The thread failed to load.');
    });
  });
});
