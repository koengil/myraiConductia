import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import * as React from 'react';

import { LeadRegistration } from '../src/components/leads/LeadRegistration';
import { NewMandateDialog } from '../src/components/wizard/NewMandateDialog';
import { FlagsProvider } from '../src/lib/flags/FlagsContext';
import { SessionProvider } from '../src/lib/session/store';
import { invalidateLeadCatalog, openNewMandateDialog } from '../src/lib/leads/leadCatalog';
import type { FlagMap } from '../src/lib/flags/resolveFlags';

/*
 * Bug bash 1 (Sep 7): a lead registered on /leads was missing from the Gate 0
 * "Search a registered lead…" picker for the rest of the session, because the
 * lead catalog is a module-level cache that nothing busts. Both journeys below
 * are the reported symptom: the catalog is warmed by one dialog visit, the
 * tenant's lead set then changes, and the next visit must show the new lead.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/projects',
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

const FLAGS_ON: FlagMap = {
  rail_templates: false,
  template_change_review: false,
  deal_data_room_nav: false,
  gate0_api_create: true,
  platform_onboarding: false,
  work_identity_onboarding: false,
  mail_channel: false,
  mail_jev_second_opinion: false,
  teaser_sandbox_runner: false,
  company_access_management: false,
  setup_walkthroughs: false,
  book_view: false,
  project_rail_model: false,
  deal_discovery: false,
  discovery_worker_enabled: false,
  discovery_model_proposals_demo: false,
  workbench_top_nav: false,
  skill_authoring: false,
  skill_output_revisions: false,
};

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

type Lead = { id: string; name: string; type: string };

/** URL-aware fetch stub over a mutable tenant lead set. GET reads it, POST
 *  /api/v1/companies appends to it, so the picker's list is only ever as
 *  fresh as the GET the component actually made. */
function stubFetch(leads: Lead[]) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/companies') && method === 'GET') {
      return Promise.resolve(jsonResponse(200, { companies: [...leads] }));
    }
    if (url === '/api/v1/companies' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { name: string };
      const company = { id: `c-${leads.length + 1}`, name: body.name, type: 'client' };
      leads.push(company);
      return Promise.resolve(jsonResponse(201, { company }));
    }
    if (url.includes('/api/v1/codenames/suggest')) {
      return Promise.resolve(jsonResponse(200, { themes: [], source: 'fallback' }));
    }
    return Promise.resolve(jsonResponse(200, {}));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderWorkspace() {
  function Harness() {
    const [open, setOpen] = React.useState(false);
    return (
      <SessionProvider>
        <FlagsProvider value={FLAGS_ON}>
          <button type="button" onClick={() => openNewMandateDialog(setOpen)}>
            New mandate
          </button>
          <LeadRegistration />
          <NewMandateDialog open={open} onClose={() => setOpen(false)} />
        </FlagsProvider>
      </SessionProvider>
    );
  }
  return render(<Harness />);
}

async function openDialog() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'New mandate' }));
  });
  await waitFor(() =>
    expect(screen.getByRole('dialog', { name: 'New mandate' })).toBeInTheDocument(),
  );
}

async function closeDialog() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  });
}

function leadOptionNames(): string[] {
  return screen
    .queryAllByRole('option')
    .map((el) => el.textContent?.trim() ?? '');
}

afterEach(() => {
  cleanup();
  invalidateLeadCatalog();
  vi.unstubAllGlobals();
});

describe('Gate 0 lead picker freshness', () => {
  it('lists a lead registered after the catalog was already warmed', async () => {
    const leads: Lead[] = [{ id: 'c-1', name: 'Nintendo', type: 'client' }];
    stubFetch(leads);
    renderWorkspace();
    await act(async () => {});

    await openDialog();
    await waitFor(() => expect(leadOptionNames()).toEqual(['Nintendo']));
    await closeDialog();

    fireEvent.change(screen.getByLabelText(/lead name/i), { target: { value: 'Reddit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register lead' }));
    await waitFor(() => expect(screen.getByLabelText(/lead name/i)).toHaveValue(''));

    await openDialog();
    await waitFor(() => expect(leadOptionNames()).toContain('Reddit'));
  });

  it('lists a lead registered elsewhere while the dialog was closed', async () => {
    const leads: Lead[] = [{ id: 'c-1', name: 'Nintendo', type: 'client' }];
    stubFetch(leads);
    renderWorkspace();
    await act(async () => {});

    await openDialog();
    await waitFor(() => expect(leadOptionNames()).toEqual(['Nintendo']));
    await closeDialog();

    leads.push({ id: 'c-2', name: 'Reddit', type: 'client' });

    await openDialog();
    await waitFor(() => expect(leadOptionNames()).toContain('Reddit'));
  });
});
