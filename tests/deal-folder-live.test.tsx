import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import * as React from 'react';

import { DealFolderSwitch } from '@/components/dataroom/DealFolderSwitch';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import type { FlagMap } from '@/lib/flags/resolveFlags';

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'atlas-2026' }),
}));

/*
 * Deal Folder flag seam (platform_onboarding).
 *
 * Flag OFF: fixture explorer (taxonomy on a non-sandbox deal).
 * Flag ON: live explorer over GET /documents, files placed in the taxonomy.
 * There is no move control — files stay where they are uploaded.
 */

const flags = (on: boolean, discovery = false): FlagMap => ({
  rail_templates: false,
  template_change_review: false,
  deal_data_room_nav: false,
  gate0_api_create: false,
  mail_channel: false,
  mail_jev_second_opinion: false,
  teaser_sandbox_runner: false,
  platform_onboarding: on,
  work_identity_onboarding: false,
  company_access_management: false,
  setup_walkthroughs: false,
    workbench_top_nav: false,
  book_view: false,
  skill_authoring: false,
  project_rail_model: false,
  deal_discovery: discovery,
  discovery_worker_enabled: false,
  discovery_model_proposals_demo: false,
  skill_output_revisions: false,
});

type LiveDoc = {
  id: string;
  name: string;
  room: 'internal' | 'deal';
  classification: number;
  minPhase: number;
  uploadedBy: string | null;
  createdAt: string;
  sizeBytes: number | null;
  contentType: string | null;
  hasFile: boolean;
  canOpen: boolean;
  folder?: string;
  folderSubpath?: string[];
};

const doc = (overrides: Partial<LiveDoc>): LiveDoc => ({
  id: 'doc-1',
  name: 'Document',
  room: 'internal',
  classification: 2,
  minPhase: 0,
  uploadedBy: 'user-1',
  createdAt: '2026-08-31T12:00:00Z',
  sizeBytes: 2048,
  contentType: 'application/pdf',
  hasFile: true,
  canOpen: true,
  folder: 'admin',
  folderSubpath: ['NDA'],
  ...overrides,
});

function mockDocuments(documents: LiveDoc[]) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ documents }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DealFolderSwitch — flag OFF', () => {
  it('renders the fixture taxonomy and never fetches', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FlagsProvider value={flags(false)}>
        <DealFolderSwitch />
      </FlagsProvider>,
    );

    expect(screen.getByText('Internal work product. No outside party can see this.')).toBeInTheDocument();
    expect(screen.getByText('00. Received from Client')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('DealFolderSwitch — flag ON (live documents)', () => {
  it('shows the eight folders and a filed document, with no move control', async () => {
    mockDocuments([
      doc({ id: 'doc-nda', name: 'Buyer NDA.docx', folder: 'admin', folderSubpath: ['NDA'] }),
    ]);

    render(
      <FlagsProvider value={flags(true)}>
        <DealFolderSwitch />
      </FlagsProvider>,
    );

    expect(await screen.findByText('1 document')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /01\. Admin/ }));
    fireEvent.click(screen.getByRole('button', { name: /^NDA/ }));
    expect(screen.getAllByText('Buyer NDA.docx').length).toBeGreaterThan(0);
    expect(screen.getAllByText('00. Received from Client').length).toBeGreaterThan(0);
    expect(screen.getAllByText('07. Closing').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /move/i })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Deal folder' })).toBeInTheDocument();
  });

  it('shows a Data Room upload in the folder it was filed to', async () => {
    mockDocuments([
      doc({
        id: 'doc-deal',
        name: 'CIM.pdf',
        room: 'deal',
        folder: 'received-from-client',
        folderSubpath: [],
      }),
    ]);

    render(
      <FlagsProvider value={flags(true)}>
        <DealFolderSwitch />
      </FlagsProvider>,
    );

    expect(await screen.findByText('1 document')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /00\. Received from Client/ }));
    expect(screen.getAllByText('CIM.pdf').length).toBeGreaterThan(0);
  });
});

describe('DealFolderSwitch — flag ON, the deal does not resolve (QA-11)', () => {
  it('answers a 404 with the shared not-on-deal state and withholds the upload form', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Deal not found' }),
      })),
    );

    render(
      <FlagsProvider value={flags(true)}>
        <DealFolderSwitch />
      </FlagsProvider>,
    );

    expect(await screen.findByText('You are not on this deal.')).toBeInTheDocument();
    expect(screen.queryByText(/not on the platform|does not exist/)).not.toBeInTheDocument();
    expect(screen.queryByText('Deal not found')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the Conductor Center' })).toHaveAttribute(
      'href',
      '/projects',
    );
    expect(screen.queryByRole('button', { name: /upload/i })).not.toBeInTheDocument();
    // One state: no empty folder tree under it.
    expect(screen.queryByRole('navigation', { name: 'Data room folders' })).not.toBeInTheDocument();
  });
});

describe('DealFolderSwitch — a failed read', () => {
  it('states a plain sentence plus Try again, never the server text', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <FlagsProvider value={flags(true)}>
        <DealFolderSwitch />
      </FlagsProvider>,
    );
    const alert = await screen.findByText('The documents could not be loaded.');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(screen.queryByText('boom')).not.toBeInTheDocument();
    const before = fetchMock.mock.calls.length;
    fireEvent.click(within(alert.parentElement as HTMLElement).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
  });

  it('does not describe the UI with a move hint', async () => {
    mockDocuments([doc({})]);
    render(
      <FlagsProvider value={flags(true)}>
        <DealFolderSwitch />
      </FlagsProvider>,
    );
    await screen.findByText('1 document');
    expect(screen.queryByText(/Moving a file is not available/)).not.toBeInTheDocument();
  });
});

describe('DealFolderSwitch — Documents / Deal email switch', () => {
  it('is absent while deal_discovery is off', async () => {
    mockDocuments([doc({})]);
    render(
      <FlagsProvider value={flags(true, false)}>
        <DealFolderSwitch />
      </FlagsProvider>,
    );
    expect(await screen.findByText('1 document')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Deal email' })).not.toBeInTheDocument();
  });

  it('swaps the explorer and the upload form for the Deal email list, and back', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).startsWith('/api/v1/discovery/deal-email')) {
        return { ok: true, status: 200, json: async () => ({ items: [], truncated: false }) };
      }
      return { ok: true, status: 200, json: async () => ({ documents: [doc({})] }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FlagsProvider value={flags(true, true)}>
        <DealFolderSwitch />
      </FlagsProvider>,
    );

    expect(await screen.findByText('1 document')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Documents' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/discovery/deal-email'), expect.anything());

    fireEvent.click(screen.getByRole('tab', { name: 'Deal email' }));
    expect(await screen.findByText('No linked email you can read on this deal.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload' })).not.toBeInTheDocument();
    expect(screen.queryByText('1 document')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/discovery/deal-email?deal=atlas-2026', expect.anything());

    fireEvent.click(screen.getByRole('tab', { name: 'Documents' }));
    expect(await screen.findByText('1 document')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument();
  });
});

describe('DealFolderSwitch: who has access', () => {
  it('names the firm deal team from the roster and no outside party', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () =>
          String(url).endsWith('/api/v1/me')
            ? { user: { id: 'u-storm', is_external: false }, company: { id: 'bank', name: 'Bank' }, mandate: null }
            : String(url).endsWith('/members')
            ? {
                members: [
                  { displayName: 'Storm', isExternal: false },
                  { displayName: 'Dana', isExternal: true, companyName: 'Atlas Capital' },
                ],
              }
            : { documents: [doc({})] },
      })),
    );
    render(
      <FlagsProvider value={flags(true)}>
        <DealFolderSwitch />
      </FlagsProvider>,
    );
    expect(await screen.findByText("Who has access on this deal: your firm's deal team (Storm). Individual files can be limited further.")).toBeInTheDocument();
  });

  it('an outside viewer reads only their own firm and the bank deal team', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).endsWith('/api/v1/me')
          ? { user: { id: 'u-sally', is_external: true }, company: { id: 'nw', name: 'Northwind Holdings' }, mandate: null }
          : String(url).endsWith('/members')
            ? { members: [{ displayName: 'Ben', isExternal: true, companyName: 'Birch Partners' }] }
            : { documents: [doc({})] },
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <FlagsProvider value={flags(true)}>
        <DealFolderSwitch />
      </FlagsProvider>,
    );
    expect(
      await screen.findByText(
        "Who has access on this deal: Northwind Holdings and the bank's deal team. The bank's deal team manages who has access.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Birch Partners/)).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/members'))).toBe(false);
  });
});
