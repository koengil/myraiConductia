import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { CandidateList, dateRangeLabel, evidenceLabel } from '@/components/discovery/CandidateList';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { FLAG_REGISTRY, type FlagKey } from '@/lib/flags/keys';
import type { FlagMap } from '@/lib/flags/resolveFlags';
import type { CandidateSummary } from '@/lib/discovery/api';

const flags = Object.fromEntries(
  (Object.keys(FLAG_REGISTRY) as FlagKey[]).map((key) => [key, key === 'deal_discovery']),
) as FlagMap;

const FALCON: CandidateSummary = {
  id: 'c-falcon',
  name: 'Project Falcon',
  codename: 'Project Falcon',
  parties: [{ name: 'Heliotrope', domain: 'heliotrope.example' }],
  firstSeenAt: '2026-02-03T09:12:00Z',
  lastSeenAt: '2026-02-20T16:05:00Z',
  evidenceCount: 6,
  ownEvidenceCount: 5,
  station: null,
};

function stubFetch(response: Promise<Response> | Response) {
  const fetchMock = vi.fn(() => Promise.resolve(response));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderList() {
  return render(
    <FlagsProvider value={flags}>
      <CandidateList />
    </FlagsProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CandidateList', () => {
  it('shows a loading state until the list arrives', async () => {
    let resolve!: (value: Response) => void;
    stubFetch(new Promise<Response>((r) => (resolve = r)));
    renderList();
    expect(screen.getByRole('status')).toHaveTextContent('Loading proposed deals');
    resolve(new Response(JSON.stringify({ candidates: [] }), { status: 200 }));
    expect(await screen.findByText(/No proposed deals/)).toBeInTheDocument();
  });

  it('renders each candidate with its parties, date range and evidence', async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify({ candidates: [FALCON] }), { status: 200 }));
    renderList();

    const heading = await screen.findByRole('heading', { name: 'Project Falcon' });
    const row = heading.closest('li')!;
    expect(within(row).getByRole('list', { name: 'Parties' })).toHaveTextContent('Heliotrope');
    expect(within(row).getByText('Feb 3, 2026 to Feb 20, 2026')).toBeInTheDocument();
    expect(within(row).getByText('6 evidence items, 5 from your mailbox')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/discovery/candidates', expect.anything());
  });

  it('shows the empty state when the viewer holds no evidence', async () => {
    stubFetch(new Response(JSON.stringify({ candidates: [] }), { status: 200 }));
    renderList();
    const empty = await screen.findByText(
      'No proposed deals. A deal appears here once your own mail is evidence for it.',
    );
    expect(empty).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('shows an error when the route fails', async () => {
    stubFetch(new Response(JSON.stringify({ error: 'x' }), { status: 500 }));
    renderList();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Proposed deals could not be loaded. Try again shortly.',
    );
  });

  it('links each name to its detail and shows the step line, or that there is none yet', async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          candidates: [
            { ...FALCON, id: 'c-kestrel', name: 'Project Kestrel', station: { station: 44, title: 'LOI Review' } },
            FALCON,
          ],
        }),
        { status: 200 },
      ),
    );
    renderList();
    const link = await screen.findByRole('link', { name: 'Project Kestrel' });
    expect(link).toHaveAttribute('href', '/discovery/c-kestrel');
    const kestrel = link.closest('li')!;
    expect(within(kestrel).getByText('Diligence · Step 44 · LOI Review')).toBeInTheDocument();
    const falcon = screen.getByRole('link', { name: 'Project Falcon' }).closest('li')!;
    expect(within(falcon).getByText('No step yet')).toBeInTheDocument();
  });

  it('says so when a candidate has no outside party yet', async () => {
    stubFetch(
      new Response(JSON.stringify({ candidates: [{ ...FALCON, parties: [] }] }), { status: 200 }),
    );
    renderList();
    expect(await screen.findByText('No outside party identified')).toBeInTheDocument();
  });
});

describe('labels', () => {
  it('formats the date range in UTC', () => {
    expect(dateRangeLabel('2026-02-03T23:30:00Z', '2026-02-03T01:00:00Z')).toBe('Feb 3, 2026');
    expect(dateRangeLabel(null, null)).toBe('Date unknown');
  });

  it('describes whose evidence it is', () => {
    expect(evidenceLabel(1, 1)).toBe('1 evidence item, all from your mailbox');
    expect(evidenceLabel(3, 0)).toBe('3 evidence items, none from your mailbox');
  });

  it('keeps visible copy free of em dashes', () => {
    for (const text of [evidenceLabel(6, 5), dateRangeLabel(FALCON.firstSeenAt, FALCON.lastSeenAt)]) {
      expect(text).not.toContain('—');
    }
  });
});
