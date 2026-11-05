import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import * as React from 'react';

import AcquirersPage from '../src/app/(authed)/projects/[projectId]/acquirers/page';
import AcquirerDetailPage from '../src/app/(authed)/projects/[projectId]/acquirers/[id]/page';
import { getApi } from '../src/lib/api';
import { acquirers as summitAcquirers } from '../src/lib/api/fixtures';
import { computeCompositeScore } from '../src/lib/scoring/composite';
import { SessionProvider } from '../src/lib/session/store';

let projectId = 'project-summit';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  useParams: () => ({ projectId }),
  usePathname: () => `/projects/${projectId}/acquirers`,
  useSearchParams: () => new URLSearchParams(),
}));

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  projectId = 'project-summit';
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Acquirers list route', () => {
  it('renders a ranked row per acquirer for a populated landscape', async () => {
    render(<AcquirersPage />);

    const anthropicScore = computeCompositeScore(
      summitAcquirers.find((a) => a.id === 'anthropic')!.fitInputs,
    ).total;

    expect(
      await screen.findByRole('button', {
        name: new RegExp(`Anthropic, composite score ${anthropicScore}`),
      }),
    ).toBeInTheDocument();

    const rows = screen.getAllByRole('button', { name: /composite score/ });
    expect(rows.length).toBe(summitAcquirers.length);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('renders the error branch when the landscape load rejects', async () => {
    vi.spyOn(getApi(), 'getAcquirers').mockRejectedValue(new Error('offline'));

    render(<AcquirersPage />);

    expect(
      await screen.findByText(
        'The acquirer landscape could not be loaded right now.',
      ),
    ).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('says so when the deal has no screened acquirers, instead of rendering nothing', async () => {
    projectId = 'project-falcon';

    render(<AcquirersPage />);

    expect(
      await screen.findByText('No acquirers screened on this deal yet.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /composite score/ }),
    ).toBeNull();
    expect(
      screen.queryByText(
        'The acquirer landscape could not be loaded right now.',
      ),
    ).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

async function renderDetail(deal: string, id: string) {
  projectId = deal;
  await act(async () => {
    render(
      <SessionProvider>
        <React.Suspense fallback={null}>
          <AcquirerDetailPage params={Promise.resolve({ projectId: deal, id })} />
        </React.Suspense>
      </SessionProvider>,
    );
  });
}

describe('Acquirer deep-dive route', () => {
  it('loads the workspace for a valid acquirer id', async () => {
    await renderDetail('project-summit', 'anthropic');

    expect(
      await screen.findByRole('heading', { name: 'Anthropic', level: 1 }),
    ).toBeInTheDocument();
  });

  it('reports an unscreened deal honestly rather than as a load failure', async () => {
    await renderDetail('project-falcon', 'anthropic');

    expect(
      await screen.findByText(
        'This acquirer is not on the screened landscape for this deal.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        'This acquirer workspace could not be loaded right now.',
      ),
    ).toBeNull();
  });

  it('points every analysis tab at its panel, which is on the page', async () => {
    await renderDetail('project-summit', 'anthropic');

    const tablist = await screen.findByRole('tablist', { name: 'Analytical artifacts' });
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Valuation', 'Culture', 'Synergy', 'Founder']);
    for (const tab of tabs) {
      const panelId = tab.getAttribute('aria-controls');
      expect(panelId, tab.textContent ?? '').toBe(tab.id.replace('-tab-', '-panel-'));
      const panel = document.getElementById(panelId!);
      expect(panel, panelId!).not.toBeNull();
      expect(panel).toHaveAttribute('role', 'tabpanel');
      expect(panel).toHaveAttribute('aria-labelledby', tab.id);
    }
  });
});
