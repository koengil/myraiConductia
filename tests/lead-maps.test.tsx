import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import * as React from 'react';

import { LeadRegistration } from '../src/components/leads/LeadRegistration';
import { LeadList } from '../src/components/leads/LeadList';
import { SessionProvider } from '../src/lib/session/store';

/*
 * Task 4a: the relationship map and stakeholder map on the /leads register
 * form become repeatable row lists that PERSIST at register time via the
 * nested POST /api/v1/companies/{id}/relationships and /stakeholders
 * endpoints. This suite covers add/remove row mechanics and register-time
 * fan-out persistence (including the empty-row and partial-failure cases).
 */

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

/** URL-aware fetch stub: GET /api/v1/companies?type=client for the list,
 *  POST /api/v1/companies for registration, POST .../relationships and
 *  .../stakeholders for the nested CRM rows. `created` flips the GET
 *  response once the company POST succeeds. */
function stubFetch(postResponse: Response = jsonResponse(201, {
  company: { id: 'c1', name: 'Atlassian', type: 'client' },
})) {
  let created = false;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/v1/companies') && (!init || !init.method || init.method === 'GET')) {
      return Promise.resolve(
        jsonResponse(200, {
          companies: created ? [{ id: 'c1', name: 'Atlassian', type: 'client' }] : [],
        }),
      );
    }
    if (url === '/api/v1/companies' && init?.method === 'POST') {
      if (postResponse.ok) created = true;
      return Promise.resolve(postResponse);
    }
    if (url.endsWith('/relationships') && init?.method === 'POST') {
      return Promise.resolve(jsonResponse(201, { relationship: { id: 'r1' } }));
    }
    if (url.endsWith('/stakeholders') && init?.method === 'POST') {
      return Promise.resolve(jsonResponse(201, { stakeholder: { id: 's1' } }));
    }
    return Promise.resolve(jsonResponse(200, {}));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderLeads() {
  function Harness() {
    const [reloadKey, setReloadKey] = React.useState(0);
    return (
      <SessionProvider>
        <LeadRegistration onCreated={() => setReloadKey((k) => k + 1)} />
        <LeadList reloadKey={reloadKey} />
      </SessionProvider>
    );
  }
  return render(<Harness />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LeadRegistration — repeatable CRM row lists', () => {
  it('Add renders a row', async () => {
    stubFetch();
    renderLeads();
    await act(async () => {});

    expect(screen.queryByLabelText(/^person$/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^name$/i)).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add relationship/i }));
    });
    expect(screen.getByLabelText(/^person$/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add stakeholder/i }));
    });
    expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();
  });

  it('Remove drops a row', async () => {
    stubFetch();
    renderLeads();
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add relationship/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add relationship/i }));
    });
    expect(screen.getAllByLabelText(/^person$/i)).toHaveLength(2);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /remove relationship 1/i }));
    });
    expect(screen.getAllByLabelText(/^person$/i)).toHaveLength(1);
  });

  it('Register persists rows to the nested endpoints', async () => {
    const fetchMock = stubFetch();
    renderLeads();
    await act(async () => {});

    fireEvent.change(screen.getByLabelText(/lead name/i), {
      target: { value: 'Atlassian' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add relationship/i }));
    });
    fireEvent.change(screen.getByLabelText(/^person$/i), {
      target: { value: 'Mike Cannon-Brookes' },
    });
    fireEvent.change(screen.getByLabelText(/relationship type/i), {
      target: { value: 'board member' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add stakeholder/i }));
    });
    fireEvent.change(screen.getByLabelText(/^name$/i), {
      target: { value: 'Scott Farquhar' },
    });
    fireEvent.change(screen.getByLabelText(/role in decision/i), {
      target: { value: 'influencer' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Register lead' }));

    await waitFor(() => expect(screen.getByLabelText(/lead name/i)).toHaveValue(''));

    const relCall = fetchMock.mock.calls.find(
      (c) => String(c[0]) === '/api/v1/companies/c1/relationships',
    );
    expect(relCall).toBeDefined();
    const relBody = JSON.parse((relCall![1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(relBody.person_name).toBe('Mike Cannon-Brookes');

    const stkCall = fetchMock.mock.calls.find(
      (c) => String(c[0]) === '/api/v1/companies/c1/stakeholders',
    );
    expect(stkCall).toBeDefined();
    const stkBody = JSON.parse((stkCall![1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(stkBody.name).toBe('Scott Farquhar');
  });

  it('Empty rows are not posted', async () => {
    const fetchMock = stubFetch();
    renderLeads();
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add relationship/i }));
    });
    // Leave Person blank.

    fireEvent.change(screen.getByLabelText(/lead name/i), {
      target: { value: 'Atlassian' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Register lead' }));

    await waitFor(() => expect(screen.getByLabelText(/lead name/i)).toHaveValue(''));

    const relCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/relationships'));
    expect(relCall).toBeUndefined();

    const companyPost = fetchMock.mock.calls.find(
      (c) => String(c[0]) === '/api/v1/companies' && (c[1] as RequestInit)?.method === 'POST',
    );
    expect(companyPost).toBeDefined();
  });

  it('A failed nested relationship POST is surfaced and the form resets (no row carried over)', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (
        url.startsWith('/api/v1/companies') &&
        (!init || !init.method || init.method === 'GET')
      ) {
        return Promise.resolve(jsonResponse(200, { companies: [] }));
      }
      if (url === '/api/v1/companies' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse(201, { company: { id: 'c1', name: 'Atlassian', type: 'client' } }),
        );
      }
      if (url.endsWith('/relationships') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(400, { error: 'bad' }));
      }
      if (url.endsWith('/stakeholders') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(201, { stakeholder: { id: 's1' } }));
      }
      return Promise.resolve(jsonResponse(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderLeads();
    await act(async () => {});

    fireEvent.change(screen.getByLabelText(/lead name/i), {
      target: { value: 'Atlassian' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add relationship/i }));
    });
    fireEvent.change(screen.getByLabelText(/^person$/i), {
      target: { value: 'Mike Cannon-Brookes' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Register lead' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/did not save/i),
    );
    // The lead was created, so the form resets: the name clears and the failed
    // relationship row is NOT carried over (it would otherwise be re-POSTed to
    // the next lead the MD types). Recovery is via the leads list.
    expect(screen.getByLabelText(/lead name/i)).toHaveValue('');
    expect(screen.queryByLabelText(/^person$/i)).not.toBeInTheDocument();
  });
});
