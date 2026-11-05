import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';

import { LeadDetail } from '../src/components/leads/LeadDetail';

/*
 * Task 4b: LeadDetail is the per-lead expansion panel mounted from LeadList.
 * It GETs the lead's persisted relationship map + stakeholder map on mount,
 * renders them, and lets the MD add (POST) or remove (DELETE) entries
 * against the existing lead.
 */

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
              person_name: 'Mike Cannon-Brookes',
              relationship_type: 'prior client',
              strength: 'High',
              source: 'HubSpot',
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
    if (url === '/api/v1/companies/c1/relationships' && method === 'POST') {
      return Promise.resolve(
        jsonResponse(201, {
          relationship: {
            id: 'r2',
            person_name: 'Jay Simons',
            relationship_type: 'colleague',
            strength: 'Medium',
            source: 'HubSpot',
          },
        }),
      );
    }
    if (url === '/api/v1/companies/c1/stakeholders' && method === 'POST') {
      return Promise.resolve(
        jsonResponse(201, {
          stakeholder: {
            id: 's2',
            name: 'Jane Doe',
            role_in_decision: 'influencer',
            motivation: 'speed',
            stance: 'Neutral',
          },
        }),
      );
    }
    if (url === '/api/v1/companies/c1/relationships/r1' && method === 'DELETE') {
      return Promise.resolve(jsonResponse(204, null));
    }
    if (url === '/api/v1/companies/c1/stakeholders/s1' && method === 'DELETE') {
      return Promise.resolve(jsonResponse(204, null));
    }
    if (url.startsWith('/api/v1/people')) {
      return Promise.resolve(
        jsonResponse(200, {
          people: [
            {
              id: 'company-user:u2',
              name: 'Jay Simons',
              email: 'jay@tokmail.dev',
              company: 'Tokmail',
              source: 'company_user',
            },
          ],
        }),
      );
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

describe('LeadDetail — per-lead relationship + stakeholder maps', () => {
  it('loads and renders both maps', async () => {
    stubFetch();
    render(<LeadDetail leadId="c1" leadName="Atlassian" />);

    expect(await screen.findByText('Mike Cannon-Brookes')).toBeInTheDocument();
    expect(await screen.findByText('Scott Farquhar')).toBeInTheDocument();
  });

  it('adds a relationship', async () => {
    const fetchMock = stubFetch();
    render(<LeadDetail leadId="c1" leadName="Atlassian" />);
    await screen.findByText('Mike Cannon-Brookes');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add relationship/i }));
    });
    const personField = screen.getByLabelText(/^person$/i);
    await act(async () => {
      fireEvent.focus(personField);
    });
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Jay Simons/i })).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.mouseDown(screen.getByRole('option', { name: /Jay Simons/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save relationship/i }));
    });

    await screen.findByText('Jay Simons');

    const postCall = fetchMock.mock.calls.find(
      (c) =>
        String(c[0]) === '/api/v1/companies/c1/relationships' &&
        (c[1] as RequestInit)?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body.person_name).toBe('Jay Simons');
  });

  it('adds a stakeholder', async () => {
    const fetchMock = stubFetch();
    render(<LeadDetail leadId="c1" leadName="Atlassian" />);
    await screen.findByText('Scott Farquhar');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add stakeholder/i }));
    });
    fireEvent.change(screen.getByLabelText(/^name$/i), {
      target: { value: 'Jane Doe' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save stakeholder/i }));
    });

    await screen.findByText('Jane Doe');

    const postCall = fetchMock.mock.calls.find(
      (c) =>
        String(c[0]) === '/api/v1/companies/c1/stakeholders' &&
        (c[1] as RequestInit)?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body.name).toBe('Jane Doe');
  });

  it('removes a relationship', async () => {
    const fetchMock = stubFetch();
    render(<LeadDetail leadId="c1" leadName="Atlassian" />);
    await screen.findByText('Mike Cannon-Brookes');

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /remove relationship Mike Cannon-Brookes/i }),
      );
    });

    await waitFor(() =>
      expect(screen.queryByText('Mike Cannon-Brookes')).not.toBeInTheDocument(),
    );

    const deleteCall = fetchMock.mock.calls.find(
      (c) =>
        String(c[0]) === '/api/v1/companies/c1/relationships/r1' &&
        (c[1] as RequestInit)?.method === 'DELETE',
    );
    expect(deleteCall).toBeDefined();
  });

  it('removes a stakeholder', async () => {
    const fetchMock = stubFetch();
    render(<LeadDetail leadId="c1" leadName="Atlassian" />);
    await screen.findByText('Scott Farquhar');

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /remove stakeholder Scott Farquhar/i }),
      );
    });

    await waitFor(() =>
      expect(screen.queryByText('Scott Farquhar')).not.toBeInTheDocument(),
    );

    const deleteCall = fetchMock.mock.calls.find(
      (c) =>
        String(c[0]) === '/api/v1/companies/c1/stakeholders/s1' &&
        (c[1] as RequestInit)?.method === 'DELETE',
    );
    expect(deleteCall).toBeDefined();
  });

  it('does not stack skill runners in the expanded maps panel', async () => {
    stubFetch();
    render(<LeadDetail leadId="c1" leadName="Atlassian" />);
    await screen.findByText('Mike Cannon-Brookes');

    expect(screen.queryByText('Skill bench')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /presearch this lead/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /source intelligence and twins/i }),
    ).not.toBeInTheDocument();
  });
});

describe('LeadDetail when the permission was revoked under the session', () => {
  it('states the access outcome instead of a generic load error on 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(403, { error: 'Not permitted' }))),
    );
    render(<LeadDetail leadId="c1" leadName="Atlassian" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot view this lead's maps/);
    expect(screen.queryByText(/Could not load this lead/)).toBeNull();
  });
});
