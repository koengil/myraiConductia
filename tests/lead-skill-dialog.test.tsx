import { describe, it, expect, afterEach, vi, beforeAll, afterAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

import { LeadList } from '../src/components/leads/LeadList';
import { MotionGlobalConfig } from 'framer-motion';

// Overlay exits finish at once, so a test awaits a close without running the
// real 180 ms motion. tests/overlay/dialog.test.tsx keeps the exit on real motion.
beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});
afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

function stubFetch() {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url.startsWith('/api/v1/companies') && method === 'GET' && !url.includes('/c1/')) {
      return Promise.resolve(
        jsonResponse(200, {
          companies: [{ id: 'c1', name: 'Atlassian', type: 'client' }],
        }),
      );
    }
    if (url === '/api/v1/companies/c1/relationships') {
      return Promise.resolve(jsonResponse(200, { relationships: [] }));
    }
    if (url === '/api/v1/companies/c1/stakeholders') {
      return Promise.resolve(jsonResponse(200, { stakeholders: [] }));
    }
    if (url === '/api/v1/companies/c1/presearch') {
      return Promise.resolve(jsonResponse(200, { latest: null }));
    }
    if (url === '/api/v1/companies/c1/twins') {
      return Promise.resolve(jsonResponse(200, { personas: [] }));
    }
    return Promise.resolve(jsonResponse(200, {}));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Lead view — skill selector', () => {
  it('hides skills until a lead is expanded', async () => {
    stubFetch();
    render(<LeadList />);

    expect(await screen.findByRole('button', { name: 'Atlassian' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run a skill on atlassian/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Skill bench')).not.toBeInTheDocument();
  });

  it('opens presearch in a modal from the expanded-lead selector', async () => {
    stubFetch();
    render(<LeadList />);

    fireEvent.click(await screen.findByRole('button', { name: 'Atlassian' }));

    // The shared Menu (Radix) opens on Enter or a pointer press, not a bare click.
    fireEvent.keyDown(await screen.findByRole('button', { name: 'Skills for Atlassian: Run a skill' }), {
      key: 'Enter',
    });
    fireEvent.click(screen.getByRole('menuitem', { name: /presearch this lead/i }));

    expect(await screen.findByRole('dialog', { name: /presearch this lead/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run presearch/i })).toBeInTheDocument();
    expect(screen.queryByText('Skill bench')).not.toBeInTheDocument();
  });

  it('keeps typed work when the scrim is pressed; Escape still closes', async () => {
    stubFetch();
    render(<LeadList />);

    fireEvent.click(await screen.findByRole('button', { name: 'Atlassian' }));
    // The shared Menu (Radix) opens on Enter or a pointer press, not a bare click.
    fireEvent.keyDown(await screen.findByRole('button', { name: 'Skills for Atlassian: Run a skill' }), {
      key: 'Enter',
    });
    fireEvent.click(screen.getByRole('menuitem', { name: /source intelligence and twins/i }));
    const dialog = await screen.findByRole('dialog', { name: /source intelligence and twins/i });

    const scrim = dialog.parentElement as HTMLElement;
    fireEvent.mouseDown(scrim);
    fireEvent.click(scrim);
    expect(screen.getByRole('dialog', { name: /source intelligence and twins/i })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /source intelligence and twins/i })).not.toBeInTheDocument();
    });
  });

  it('opens source intelligence in a modal and can dismiss it', async () => {
    stubFetch();
    render(<LeadList />);

    fireEvent.click(await screen.findByRole('button', { name: 'Atlassian' }));
    // The shared Menu (Radix) opens on Enter or a pointer press, not a bare click.
    fireEvent.keyDown(await screen.findByRole('button', { name: 'Skills for Atlassian: Run a skill' }), {
      key: 'Enter',
    });
    fireEvent.click(screen.getByRole('menuitem', { name: /source intelligence and twins/i }));

    expect(await screen.findByRole('dialog', { name: /source intelligence and twins/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /extract from debrief/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /source intelligence and twins/i })).not.toBeInTheDocument();
    });
  });
});
