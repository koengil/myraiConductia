import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

import { RelationshipPathingPanel } from '../src/components/rail/RelationshipPathingPanel';

vi.mock('@/lib/leads/useDealTargetCompany', () => ({
  useDealTargetCompany: () => ({
    status: 'ready',
    companyId: 'c1',
    companyName: 'Atlassian',
  }),
}));

const flags = vi.hoisted(() => ({ api: false }));
vi.mock('@/lib/flags/FlagsContext', () => ({
  useFlag: (name: string) => (name === 'gate0_api_create' ? flags.api : false),
}));

vi.mock('@/lib/audit/store', () => ({
  logAudit: vi.fn(),
}));

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

    if (url === '/api/v1/companies/c1/relationships' && method === 'GET') {
      return Promise.resolve(
        jsonResponse(200, {
          relationships: [
            {
              id: 'r1',
              person_name: 'Jane Doe',
              relationship_type: 'prior client',
              strength: 'High',
              source: 'HubSpot',
              confidence: 'High',
            },
          ],
        }),
      );
    }
    if (url === '/api/v1/companies/c1/stakeholders' && method === 'GET') {
      return Promise.resolve(
        jsonResponse(200, {
          stakeholders: [
            {
              id: 's1',
              name: 'Scott Farquhar',
              role_in_decision: 'decision-maker',
              motivation: 'legacy',
              stance: 'Supporter',
            },
          ],
        }),
      );
    }
    if (url === '/api/v1/companies/c1/paths' && method === 'GET') {
      return Promise.resolve(jsonResponse(200, { paths: [] }));
    }
    if (url.includes('/steps/p1-s8') && method === 'GET') {
      return Promise.resolve(
        jsonResponse(200, { step: { work: { pathing_brief: '## Deciders\n\nAda signs.' } } }),
      );
    }
    if (url === '/api/v1/companies/c1/paths' && method === 'POST') {
      return Promise.resolve(
        jsonResponse(201, {
          path: {
            id: 'p1',
            stakeholder_id: 's1',
            relationship_id: 'r1',
            path_type: 'warm',
            approved: false,
            approved_by: null,
            approved_on: null,
          },
        }),
      );
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  flags.api = false;
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('RelationshipPathingPanel', () => {
  it('loads stakeholders and relationships from the API', async () => {
    stubFetch();
    render(<RelationshipPathingPanel dealId="project-summit" />);

    expect(await screen.findByText('Scott Farquhar')).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByLabelText('Warm path')).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Skill brief' })).toBeInTheDocument();
    expect(screen.getByText('Ada signs.')).toBeInTheDocument();
  });

  it('saves a warm path when an introducer is selected', async () => {
    const fetchMock = stubFetch();
    render(<RelationshipPathingPanel dealId="project-summit" />);

    await screen.findByText('Scott Farquhar');
    fireEvent.change(screen.getByLabelText('Warm path'), {
      target: { value: 'r1' },
    });

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => {
        if (String(c[0]) !== '/api/v1/companies/c1/paths') return false;
        const init = c[1] as RequestInit | undefined;
        if (init?.method !== 'POST') return false;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return body.stakeholder_id === 's1' && body.relationship_id === 'r1';
      })).toBe(true),
    );
  });

  it('keeps Approve paths off until an introducer is chosen', async () => {
    stubFetch();
    render(<RelationshipPathingPanel dealId="project-summit" />);

    await screen.findByText('Scott Farquhar');
    const select = screen.getByLabelText('Warm path');
    expect(select).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Approve paths' })).toBeDisabled();
    expect(
      screen.getByText(/Choose an introducer or Cold for 1 stakeholder/),
    ).toBeInTheDocument();
  });

  it('enables Approve paths after a warm path is drafted', async () => {
    stubFetch();
    render(<RelationshipPathingPanel dealId="project-summit" />);

    await screen.findByText('Scott Farquhar');
    fireEvent.change(screen.getByLabelText('Warm path'), {
      target: { value: 'r1' },
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Approve paths' })).toBeEnabled(),
    );
  });

  it('does not advance the rail when the server refuses the completion, and retries it (#250)', async () => {
    flags.api = true;
    const fetchMock = stubFetch();
    const base = fetchMock.getMockImplementation()!;
    // A failure that is not the seat (a 403 is the seat: see tests/rail/seatCannotAct.test.tsx).
    let patchStatus = 500;
    fetchMock.mockImplementation((input, init) => {
      if (init?.method === 'PATCH') return Promise.resolve(jsonResponse(patchStatus, { currentStepId: "committed-next-step" }));
      if (String(input) === '/api/v1/companies/c1/paths' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        return Promise.resolve(
          jsonResponse(201, {
            path: {
              id: 'p1',
              stakeholder_id: 's1',
              relationship_id: 'r1',
              path_type: 'warm',
              approved: Boolean(body.approve),
              approved_by: null,
              approved_on: null,
            },
          }),
        );
      }
      return base(input, init);
    });
    const onApproved = vi.fn();
    render(<RelationshipPathingPanel dealId="project-summit" onApproved={onApproved} />);

    await screen.findByText('Scott Farquhar');
    fireEvent.change(screen.getByLabelText('Warm path'), { target: { value: 'r1' } });
    const approve = screen.getByRole('button', { name: 'Approve paths' });
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(approve);

    expect(
      await screen.findByText('The paths are saved, but the step could not be completed. Try again.'),
    ).toBeInTheDocument();
    expect(onApproved).not.toHaveBeenCalled();

    // Every path is approved now; the button retries the completion alone.
    patchStatus = 200;
    const complete = screen.getByRole('button', { name: 'Complete step' });
    expect(complete).toBeEnabled();
    fireEvent.click(complete);
    await waitFor(() => expect(onApproved).toHaveBeenCalledWith('committed-next-step'));
  });

  it('shows the filed path without approve or add when read-only', async () => {
    stubFetch();
    render(<RelationshipPathingPanel dealId="project-summit" readOnly />);

    expect(await screen.findByText('Scott Farquhar')).toBeInTheDocument();
    expect(screen.getByText(/Filed paths for outreach/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve paths' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add stakeholder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add relationship' })).toBeNull();
    expect(screen.getByLabelText('Warm path')).toBeDisabled();
  });
});
