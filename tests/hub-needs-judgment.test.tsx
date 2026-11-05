import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';

import { NeedsJudgment } from '../src/components/workspace/commandCenter/NeedsJudgment';
import { needsYouRows } from '../src/lib/deals/commandCenter';
import { useNotifications } from '../src/lib/notifications/useNotifications';

/*
 * Needs your judgment against the real notifications hook (fetch stubbed):
 * A refused "Mark as read" puts the item back and says so.
 */

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

const now = new Date().toISOString();
const HOLD = {
  id: 'n-hold',
  deal_id: null,
  event_type: 'compliance_hold',
  payload: {},
  read_at: null,
  created_at: now,
};

function Harness() {
  const n = useNotifications();
  return (
    <NeedsJudgment
      rows={needsYouRows(n.items)}
      inbox={{ busyId: null, match: () => null }}
      onDecide={() => undefined}
      onMarkRead={(id) => void n.markRead(id)}
      markReadFailedId={n.markReadFailedId}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('NeedsJudgment mark-read failure', () => {
  it('with the PATCH answering 500, the item stays unread and the row says so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(
          String(input) === '/api/v1/notifications'
            ? jsonResponse(200, { notifications: [HOLD] })
            : jsonResponse(500, { error: 'boom' }),
        ),
      ),
    );
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as read' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not mark as read.');
    const row = screen.getByTestId('needs-you-row');
    expect(within(row).getByRole('alert')).toBe(alert);
    expect(within(row).getByRole('button', { name: 'Mark as read' })).toBeInTheDocument();
  });

  it('a successful mark-read takes the item off the list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(
          String(input) === '/api/v1/notifications'
            ? jsonResponse(200, { notifications: [HOLD] })
            : jsonResponse(200, { notification: {} }),
        ),
      ),
    );
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as read' }));
    await waitFor(() => expect(screen.queryByTestId('needs-you-row')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
