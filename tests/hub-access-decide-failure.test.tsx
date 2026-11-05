import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';

import { NeedsJudgment } from '../src/components/workspace/commandCenter/NeedsJudgment';
import { NotificationsBell } from '../src/components/notifications/NotificationsBell';
import { needsYouRows } from '../src/lib/deals/commandCenter';
import { useAccessInbox, ACCESS_DECIDE_FAILED } from '../src/lib/access/useAccessInbox';
import { useNotifications } from '../src/lib/notifications/useNotifications';

/*
 * A refused Approve or Deny on an access request is
 * shown on that row, in Needs your judgment and in the bell.
 */

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

function stubAccess(patch: Response) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/v1/notifications') {
      return Promise.resolve(
        jsonResponse(200, {
          notifications: [
            {
              id: 'n-access',
              deal_id: null,
              event_type: 'access_requested',
              payload: { actor: 'Rob', destinationLabel: 'Leads', requestId: 'req-1' },
              read_at: null,
              created_at: new Date().toISOString(),
            },
          ],
        }),
      );
    }
    if (url === '/api/v1/access-requests' && !init?.method) {
      return Promise.resolve(
        jsonResponse(200, {
          inbox: [{ id: 'req-1', requesterName: 'Rob', destinationLabel: 'Leads', createdAt: new Date().toISOString() }],
        }),
      );
    }
    if (url === '/api/v1/access-requests/req-1') return Promise.resolve(patch);
    return Promise.resolve(jsonResponse(200, {}));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function Harness() {
  const n = useNotifications();
  const inbox = useAccessInbox();
  return (
    <NeedsJudgment
      rows={needsYouRows(n.items)}
      inbox={inbox}
      onDecide={(notificationId, requestId, decision) =>
        void inbox.decide(requestId, decision).then((ok) => (ok ? n.markRead(notificationId) : undefined))
      }
      onMarkRead={(id) => void n.markRead(id)}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('NeedsJudgment: a refused access decision', () => {
  it('a 403 with a plain server reason keeps the row and shows the reason', async () => {
    stubAccess(jsonResponse(403, { error: 'You can only grant permissions you already hold.' }));
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const row = screen.getByTestId('needs-you-row');
    expect(await within(row).findByRole('alert')).toHaveTextContent(
      'You can only grant permissions you already hold.',
    );
    expect(within(row).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('a 500 with a raw server message shows the plain fallback', async () => {
    stubAccess(jsonResponse(500, { error: 'duplicate key value violates unique constraint' }));
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const row = screen.getByTestId('needs-you-row');
    expect(await within(row).findByRole('alert')).toHaveTextContent(ACCESS_DECIDE_FAILED);
    expect(ACCESS_DECIDE_FAILED).toBe('The request could not be updated.');
  });
});

describe('NotificationsBell: a refused access decision', () => {
  it('a 500 keeps the row and shows the alert line on it', async () => {
    const fetchMock = stubAccess(jsonResponse(500, { error: 'Forbidden' }));
    render(<NotificationsBell />);
    fireEvent.click(await screen.findByRole('button', { name: /1 unread/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/v1/access-requests/req-1', expect.objectContaining({ method: 'PATCH' })),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('The request could not be updated.');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });
});
