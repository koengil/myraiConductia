import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import * as React from 'react';

import { LeadRegistration } from '../src/components/leads/LeadRegistration';
import { LeadList } from '../src/components/leads/LeadList';
import { SessionProvider } from '../src/lib/session/store';
import {
  DUPLICATE_COMPANY_NAME_CODE,
  LEAD_NAME_MAX_LENGTH,
} from '../src/lib/validation/inputPolicy';

/*
 * Lead registration (Task 2, extended by Task 4a). A lead is a `client`-type
 * company: the name persists via POST /api/v1/companies. The relationship
 * map and stakeholder map are repeatable row lists (see
 * tests/lead-maps.test.tsx for their add/remove/persist coverage). This suite
 * locks the no-rows boundary: with nothing added to either map, only the
 * name (and CLIENT type) travels in the company POST body, and the list
 * refetches on success.
 */

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

/** URL-aware fetch stub: GET /api/v1/companies?type=client for the list,
 *  POST /api/v1/companies for registration. `created` flips the GET response
 *  once a POST succeeds, so the list assertion proves a real refetch. */
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
    if (url === '/api/v1/access-requests' && init?.method === 'POST') {
      return Promise.resolve(
        jsonResponse(201, { request: { destination: 'leads_create', status: 'pending' } }),
      );
    }
    if (url === '/api/v1/access-requests') {
      return Promise.resolve(jsonResponse(200, { mine: [] }));
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

describe('LeadRegistration', () => {
  it('renders repeatable relationship and stakeholder row editors', async () => {
    stubFetch();
    renderLeads();
    await act(async () => {});

    expect(screen.getByLabelText(/lead name/i)).toBeInTheDocument();

    // The two CRM groups, grouped and labeled, always render.
    expect(screen.getByRole('group', { name: /relationship map/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /stakeholder map/i })).toBeInTheDocument();

    // Both lists start empty; the add controls are the entry point.
    const addRelationship = screen.getByRole('button', { name: /add relationship/i });
    const addStakeholder = screen.getByRole('button', { name: /add stakeholder/i });
    expect(addRelationship).toBeInTheDocument();
    expect(addStakeholder).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(addRelationship);
    });
    await act(async () => {
      fireEvent.click(addStakeholder);
    });

    // A representative field from each group now appears.
    expect(screen.getByLabelText(/relationship type/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^strength$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/role in decision/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/stance toward us/i)).toBeInTheDocument();

    // Empty-list state before anything is registered.
    expect(screen.getByText(/no leads registered yet/i)).toBeInTheDocument();
  });

  it('carries no hint lines that only describe the UI', async () => {
    stubFetch();
    renderLeads();
    await act(async () => {});
    expect(screen.queryByText(/persists as a company record/i)).toBeNull();
    expect(screen.queryByText(/select \+ to add/i)).toBeNull();
  });

  it('registers a name-only lead when no relationships or stakeholders are added', async () => {
    const fetchMock = stubFetch();
    renderLeads();
    await act(async () => {});

    fireEvent.change(screen.getByLabelText(/lead name/i), {
      target: { value: 'Atlassian' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Register lead' }));

    // The name field clears on success.
    await waitFor(() => expect(screen.getByLabelText(/lead name/i)).toHaveValue(''));

    // The list refetches and now shows the registered lead.
    expect(await screen.findByText('Atlassian')).toBeInTheDocument();

    const postCall = fetchMock.mock.calls.find(
      (c) => String(c[0]) === '/api/v1/companies' && (c[1] as RequestInit)?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    // No-rows boundary: only name (+ the CLIENT type) travels.
    expect(body).toEqual({ name: 'Atlassian', type: 'client' });

    // No nested CRM POST fired for either list.
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/relationships')),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/stakeholders')),
    ).toBe(false);
  });

  it('does not submit an empty name', async () => {
    const fetchMock = stubFetch();
    renderLeads();
    await act(async () => {});

    expect(screen.getByRole('button', { name: 'Register lead' })).toBeDisabled();
    expect(
      fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === 'POST'),
    ).toBe(false);
  });

  it('surfaces a decisive error on a duplicate name and does not clear the field', async () => {
    stubFetch(jsonResponse(409, { error: 'Your organization already has a lead with this name' }));
    renderLeads();
    await act(async () => {});

    fireEvent.change(screen.getByLabelText(/lead name/i), {
      target: { value: 'Atlassian' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Register lead' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /your organization already has a lead/i,
    );
    expect(screen.getByLabelText(/lead name/i)).toHaveValue('Atlassian');
  });
  it('refuses a one-character name before it reaches the API', async () => {
    const fetchMock = stubFetch();
    renderLeads();
    await act(async () => {});

    fireEvent.change(screen.getByLabelText(/lead name/i), { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: /register lead/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 2 characters/i);
    expect(
      fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === 'POST'),
    ).toBe(false);
  });

  it('caps the name field at the shared limit', async () => {
    stubFetch();
    renderLeads();
    await act(async () => {});

    expect(screen.getByLabelText(/lead name/i)).toHaveAttribute(
      'maxlength',
      String(LEAD_NAME_MAX_LENGTH),
    );
  });

  it('warns on a name that matches an existing company, then registers on confirmation', async () => {
    const fetchMock = stubFetch(
      jsonResponse(409, {
        error: 'Atlassian is already on the platform as a target. Register this lead anyway, or use the existing record.',
        code: DUPLICATE_COMPANY_NAME_CODE,
      }),
    );
    renderLeads();
    await act(async () => {});

    fireEvent.change(screen.getByLabelText(/lead name/i), { target: { value: 'Atlassian' } });
    fireEvent.click(screen.getByRole('button', { name: /register lead/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already on the platform as a target/i);
    expect(screen.getByLabelText(/lead name/i)).toHaveValue('Atlassian');

    fireEvent.click(screen.getByRole('button', { name: /register anyway/i }));
    fireEvent.click(screen.getByRole('button', { name: /register lead/i }));

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        (c) => String(c[0]) === '/api/v1/companies' && (c[1] as RequestInit)?.method === 'POST',
      );
      expect(posts).toHaveLength(2);
      const body = JSON.parse((posts[1][1] as RequestInit).body as string) as Record<string, unknown>;
      expect(body.confirmDuplicate).toBe(true);
    });
  });
});

describe('LeadList', () => {
  it('truncates a long lead name and keeps it readable on hover', async () => {
    const longName = 'Z'.repeat(600);
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(jsonResponse(200, { companies: [{ id: 'c9', name: longName, type: 'client' }] })),
      ),
    );
    render(
      <SessionProvider>
        <LeadList />
      </SessionProvider>,
    );

    const label = await screen.findByTitle(longName);
    expect(label).toHaveTextContent(longName);
    expect(label.className).toContain('truncate');
  });
});

describe('LeadList register control', () => {
  it('opens the permission wall when the caller cannot create leads', async () => {
    stubFetch();
    render(
      <SessionProvider>
        <LeadList />
      </SessionProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Register a lead' }));
    expect(
      await screen.findByText(/You need permission from an organization administrator to register a lead/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/lead name/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Register lead' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Request access' })).toBeInTheDocument();
  });

  it('lets the caller request Create leads from the permission wall', async () => {
    const fetchMock = stubFetch();
    render(
      <SessionProvider>
        <LeadList />
      </SessionProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Register a lead' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Request access' }));
    expect(
      await screen.findByText('Your request is waiting for an administrator.'),
    ).toBeInTheDocument();
    const postCall = fetchMock.mock.calls.find(
      (c) => String(c[0]) === '/api/v1/access-requests' && (c[1] as RequestInit)?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({
      destination: 'leads_create',
    });
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request access' })).toBeNull();
  });

  it('opens the registration form when the caller can create leads', async () => {
    stubFetch();
    render(
      <SessionProvider>
        <LeadList canCreate />
      </SessionProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Register a lead' }));
    expect(await screen.findByLabelText(/lead name/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register lead' })).toBeInTheDocument();
    expect(
      screen.queryByText(/You need permission from an organization administrator to register a lead/),
    ).toBeNull();
  });

  it('picks up Create leads after approval without a page refresh', async () => {
    const me = {
      user: {
        id: 'u-martin',
        is_external: false,
        firm_role: null,
        company_id: 'co-1',
        company_role: 'member',
      },
      company_permissions: [{ permissionKey: 'company:leads:view' }],
    };
    const inner = stubFetch();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/v1/me') {
          return Promise.resolve(jsonResponse(200, me));
        }
        return inner(input, init);
      }),
    );
    render(
      <SessionProvider>
        <LeadList />
      </SessionProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Register a lead' }));
    expect(
      await screen.findByText(/You need permission from an organization administrator to register a lead/),
    ).toBeInTheDocument();

    me.company_permissions = [
      { permissionKey: 'company:leads:view' },
      { permissionKey: 'company:leads:create' },
    ];
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(await screen.findByLabelText(/lead name/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/You need permission from an organization administrator to register a lead/),
    ).toBeNull();
  });
});
