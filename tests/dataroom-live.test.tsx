import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import * as React from 'react';

import { DataRoomSwitch } from '@/components/dataroom/DataRoomSwitch';
const me = vi.hoisted(() => ({
  state: { status: 'ready', data: { user: { is_external: false } } } as
    | { status: 'ready'; data: { user: { is_external: boolean }; company?: { id: string; name: string } | null } }
    | { status: 'loading'; email: null },
}));
vi.mock('@/lib/auth/useCurrentUser', () => ({
  useCurrentUser: () => ({ state: me.state }),
}));

const slot = vi.hoisted(() => ({ props: [] as Array<{ dealId: string; onCreated?: () => void }> }));
vi.mock('@/components/dataroom/DataRoomAccessInvite', () => ({
  DataRoomAccessInvite: (props: { dealId: string; onCreated?: () => void }) => {
    slot.props.push(props);
    return <button type="button">Give data room access</button>;
  },
}));

import { FlagsProvider } from '@/lib/flags/FlagsContext';
import type { FlagMap } from '@/lib/flags/resolveFlags';

/*
 * Data Room flag seam (platform_onboarding).
 *
 * Contracts under test:
 *   1. Flag OFF renders the fixture explorer, byte-for-byte today's surface.
 *   2. Flag ON renders the live rows GET /api/v1/deals/{dealId}/documents
 *      returns, split by room (Deal Folder filings / client documents).
 *   3. Zero internal rows omit the Deal Folder section entirely, so an external
 *      viewer never sees an empty internal header.
 */

const flags = (on: boolean): FlagMap => ({
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
  book_view: false,
  project_rail_model: false,
  deal_discovery: false,
  discovery_worker_enabled: false,
  discovery_model_proposals_demo: false,
  workbench_top_nav: false,
  skill_authoring: false,
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
};

const doc = (overrides: Partial<LiveDoc>): LiveDoc => ({
  id: 'doc-1',
  name: 'Document',
  room: 'deal',
  classification: 2,
  minPhase: 0,
  uploadedBy: 'user-1',
  createdAt: '2026-07-30T12:00:00Z',
  sizeBytes: 2048,
  contentType: 'application/pdf',
  hasFile: true,
  canOpen: true,
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
  me.state = { status: 'ready', data: { user: { is_external: false } } };
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DataRoomSwitch — flag OFF', () => {
  it('renders the fixture explorer and never fetches', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FlagsProvider value={flags(false)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );

    // The fixture explorer's kind-driven access note.
    expect(
      screen.getByText('Client documents. Staged buyer access.'),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('DataRoomSwitch — flag ON (live documents)', () => {
  it('renders the returned rows split by room', async () => {
    mockDocuments([
      doc({ id: 'doc-int', name: 'Fee model.xlsx', room: 'internal' }),
      doc({ id: 'doc-deal', name: 'CIM v4.pdf', room: 'deal', classification: 3 }),
    ]);

    render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );

    expect(await screen.findByText('Fee model.xlsx')).toBeInTheDocument();
    expect(screen.getByText('CIM v4.pdf')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Client documents folder' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Deal Folder' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Client documents' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Room' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Classification' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Min phase')).not.toBeInTheDocument();
  });

  it('omits the internal section when the server returns no internal rows', async () => {
    mockDocuments([doc({ id: 'doc-deal', name: 'Teaser.pdf', room: 'deal' })]);

    render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );

    expect(await screen.findByText('Teaser.pdf')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Deal Folder' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Client documents' })).toBeInTheDocument();
  });
});

describe('DataRoomSwitch — rows without a stored file', () => {
  it('reads as a record, never as a zero-byte download', async () => {
    mockDocuments([
      doc({ id: 'doc-stub', name: 'Board deck.pdf', sizeBytes: null, hasFile: false }),
    ]);

    render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );

    expect(await screen.findByText('Board deck.pdf')).toBeInTheDocument();
    expect(screen.getByText('Record only')).toBeInTheDocument();
    expect(screen.queryByText('0 B')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Download/ })).not.toBeInTheDocument();
  });

  it('a cleared row with a stored file keeps its real size and download', async () => {
    mockDocuments([doc({ id: 'doc-real', name: 'CIM.pdf', sizeBytes: 2048 })]);

    render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );

    expect(await screen.findByText('CIM.pdf')).toBeInTheDocument();
    expect(screen.getByText('2 KB')).toBeInTheDocument();
    expect(screen.queryByText('Record only')).not.toBeInTheDocument();
  });
});

describe('DataRoomSwitch — flag ON, the deal does not resolve (QA-11)', () => {
  function mockFailure(status: number, error: string) {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status,
      json: async () => ({ error }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('answers a 404 with the shared not-on-deal state and the way back, never the API string', async () => {
    mockFailure(404, 'Deal not found');

    render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
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
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('answers a 401 as an ended session with a way to sign in', async () => {
    mockFailure(401, 'Unauthorized');

    render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );

    expect(
      await screen.findByRole('heading', { name: 'Your session has ended' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  // The documents route answers a non-member with the "no such deal" 404
  // (decision-log D65); its only 403 is an account gate such as MFA, which is a
  // failed read, never the not-on-deal state or a seat problem.
  it('answers a 403 as a failed read with Try again, never as not on the deal', async () => {
    mockFailure(403, 'Forbidden');

    render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('The documents could not be loaded.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('You are not on this deal.')).not.toBeInTheDocument();
    expect(screen.queryByText('Your seat does not cover this deal')).not.toBeInTheDocument();
    expect(screen.queryByText('Forbidden')).not.toBeInTheDocument();
  });

  it('keeps the retryable error path for a server fault', async () => {
    mockFailure(500, 'documents lookup failed');

    render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );

    expect(await screen.findByText('The documents could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText('documents lookup failed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('DataRoomSwitch: layout, access line and access entry', () => {
  function mockRoom(documents: LiveDoc[], members: unknown[], seatRole = 'seller') {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).endsWith('/api/v1/me')
          ? { user: { id: 'u-1', is_external: true }, memberships: [{ deal_id: 'd-uuid', deal_code: 'project-summit', deal_role: seatRole }] }
          : String(url).endsWith('/members')
            ? { members }
            : { documents },
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('says who has access from the deal roster', async () => {
    mockRoom([doc({})], [
      { displayName: 'Storm', isExternal: false, companyName: 'Bank' },
      { displayName: 'Dana', isExternal: true, companyName: 'Atlas Capital' },
    ]);
    render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );
    expect(await screen.findByText(/Who has access on this deal: your firm's deal team \(Storm\), plus Atlas Capital \(1\)\./)).toBeInTheDocument();
  });

  // Handoff E25: an outside viewer's line names only their own firm
  // and the bank's deal team, never another party's name or count.
  const FULL_ROSTER = [
    { displayName: 'Storm', isExternal: false, companyName: 'Bank' },
    { displayName: 'Morgan', isExternal: false, companyName: 'Bank' },
    { displayName: 'Sally', isExternal: true, companyName: 'Northwind Holdings', dealRole: 'seller' },
    { displayName: 'Ben', isExternal: true, companyName: 'Birch Partners', dealRole: 'buyer' },
    { displayName: 'Cara', isExternal: true, companyName: 'Cedar Capital', dealRole: 'buyer' },
  ];

  it.each([
    ['seller', 'Northwind Holdings', ['Birch Partners', 'Cedar Capital']],
    ['buyer', 'Birch Partners', ['Northwind Holdings', 'Cedar Capital']],
  ])('a %s viewer sees only their own firm and the bank deal team', async (_side, ownFirm, others) => {
    me.state = { status: 'ready', data: { user: { is_external: true }, company: { id: 'c', name: ownFirm } } };
    const fetchMock = mockRoom([doc({})], FULL_ROSTER);
    render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );
    const line = await screen.findByTestId('who-has-access');
    expect(line).toHaveTextContent(
      `Who has access on this deal: ${ownFirm} and the bank's deal team. The bank's deal team manages who has access.`,
    );
    expect(line.textContent).not.toContain("your firm's deal team");
    for (const other of others) expect(line.textContent).not.toContain(other);
    expect(line.textContent).not.toMatch(/\(\d+\)/);
    // The line needs no roster read for an outside viewer.
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/members'))).toBe(false);
  });

  it('a bank viewer reads outside seats by firm, or by party role with no company', async () => {
    mockRoom([doc({})], [
      { displayName: 'Storm', isExternal: false, companyName: 'Bank' },
      { displayName: 'Sally', isExternal: true, companyName: null, dealRole: 'seller' },
      { displayName: 'Ben', isExternal: true, companyName: null, dealRole: 'buyer' },
    ]);
    render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );
    expect(
      await screen.findByText(/Who has access on this deal: your firm's deal team \(Storm\), plus Seller \(1\) and Buyer \(1\)\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Outside party/)).toBeNull();
  });

  it('fails closed while the profile loads: the outside line, no roster read', async () => {
    me.state = { status: 'loading', email: null };
    const fetchMock = mockRoom([doc({})], FULL_ROSTER);
    render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );
    expect(await screen.findByTestId('who-has-access')).toHaveTextContent("The bank's deal team manages who has access.");
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/members'))).toBe(false);
  });

  it('mounts the access entry slot with the deal and a reload callback', async () => {
    slot.props.length = 0;
    const fetchMock = mockRoom([doc({})], []);
    render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Give data room access' })).toBeInTheDocument();
    const before = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/documents')).length;
    slot.props[slot.props.length - 1].onCreated?.();
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/documents')).length).toBeGreaterThan(before),
    );
  });

  it('tags each row with its Deal Folder category and writes no em dash', async () => {
    mockRoom([
      doc({ id: 'a', name: 'CIM.pdf', room: 'internal', folder: 'marketing-materials' } as Partial<LiveDoc>),
      doc({ id: 'b', name: 'Stub.pdf', hasFile: false, sizeBytes: null }),
    ], []);
    const { container } = render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );
    expect(await screen.findByText('03. Marketing Materials')).toBeInTheDocument();
    expect(screen.getByText('Not shown')).toBeInTheDocument();
    expect(container.textContent).not.toContain('\u2014');
  });

  it('shows no Deal Folder category or mention to an outside viewer', async () => {
    me.state = { status: 'ready', data: { user: { is_external: true } } };
    mockRoom([doc({ id: 'c', name: 'Their file.pdf', room: 'deal', folder: 'buyers' } as Partial<LiveDoc>)], []);
    const { container } = render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );
    expect(await screen.findByText('Their file.pdf')).toBeInTheDocument();
    const rows = Array.from(container.querySelectorAll('ul li')).map((li) => li.textContent).join(' ');
    expect(rows).not.toContain('04. Buyers');
    expect(container.querySelector('header')!.textContent).not.toMatch(/Deal Folder/);
  });

  it('tells a bank viewer where work product lives, in outside-party terms', async () => {
    mockRoom([doc({ id: 'i', name: 'Model.xlsx', room: 'internal' })], []);
    render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );
    expect((await screen.findAllByText(/no outside party can see/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/client cannot/i)).not.toBeInTheDocument();
  });

  it('a bank viewer with no Deal Folder rows still sees the Deal Folder note and the folder choice', async () => {
    mockRoom([doc({ id: 'c', name: 'Theirs.pdf', room: 'deal' })], []);
    const { container } = render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );
    expect(await screen.findByText('Theirs.pdf')).toBeInTheDocument();
    expect(container.querySelector('header')!.textContent).toMatch(/Deal Folder/);
    expect(screen.getByRole('combobox', { name: 'Client documents folder' })).toBeInTheDocument();
  });

  it('fails closed while the profile loads: no Deal Folder note and no folder choice', async () => {
    me.state = { status: 'loading', email: null };
    mockRoom([doc({ id: 'c', name: 'Theirs.pdf', room: 'deal' })], []);
    const { container } = render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );
    expect(await screen.findByText('Theirs.pdf')).toBeInTheDocument();
    expect(container.querySelector('header')!.textContent).not.toMatch(/Deal Folder/);
    expect(screen.queryByRole('combobox', { name: 'Client documents folder' })).not.toBeInTheDocument();
  });

  it('an external seller uploads without a folder choice or folder fields', async () => {
    me.state = { status: 'ready', data: { user: { is_external: true } } };
    const fetchMock = mockRoom([doc({ id: 'c', name: 'Theirs.pdf', room: 'deal' })], []);
    const calls = () => fetchMock.mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );
    expect(await screen.findByText('Theirs.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Client documents folder' })).not.toBeInTheDocument();
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    const file = new File(['x'], 'Seller.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(calls().some(([, init]) => init?.method === 'POST')).toBe(true));
    const post = calls().find(([, init]) => init?.method === 'POST')!;
    const body = post[1]!.body as FormData;
    expect(body.has('folder')).toBe(false);
    expect(body.has('folderSubpath')).toBe(false);
  });

  // The Data Room upload says where the file goes.
  it('labels the folder choice as the client documents folder, with no Deal Folder text and the visibility note', async () => {
    mockRoom([doc({ id: 'c', name: 'Theirs.pdf', room: 'deal' })], []);
    render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );
    expect(await screen.findByText('Theirs.pdf')).toBeInTheDocument();
    const panel = screen.getByRole('region', { name: 'Upload a document' });
    const select = within(panel).getByRole('combobox', { name: 'Client documents folder' });
    expect(panel.textContent).not.toMatch(/deal folder/i);
    expect(within(panel).getByText('Visible to the client and the buyers you give access.')).toBeInTheDocument();
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent ?? '');
    expect(options.length).toBeGreaterThan(0);
    for (const internal of ['01. Admin', '02. Client Presentations', '03. Marketing Materials', '04. Buyers', '07. Closing']) {
      expect(options.some((o) => o.startsWith(internal))).toBe(false);
    }
    expect(options[0]).toBe('00. Received from Client');
  });

  it('shows the category chip on Client documents rows for a bank viewer', async () => {
    mockRoom([doc({ id: 'u', name: 'Uploaded.txt', room: 'deal', folder: 'received-from-client' } as Partial<LiveDoc>)], []);
    render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );
    const section = await screen.findByRole('region', { name: 'Client documents' });
    expect(await within(section).findByText('00. Received from Client')).toBeInTheDocument();
  });

  it('hides the upload form from an outside read-only seat', async () => {
    me.state = { status: 'ready', data: { user: { is_external: true } } };
    mockRoom([doc({ id: 'c', name: 'Theirs.pdf', room: 'deal' })], [], 'read_only');
    render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );
    expect(await screen.findByText('Theirs.pdf')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('region', { name: 'Upload a document' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
  });

  // The server takes outside uploads from sellers only
  // (documentAccess.ts userCanUploadDocument), so no other outside seat gets a form.
  it.each(['buyer', 'legal'])('an outside %s seat gets no upload form', async (role) => {
    me.state = { status: 'ready', data: { user: { is_external: true } } };
    mockRoom([doc({ id: 'c', name: 'Theirs.pdf', room: 'deal' })], [], role);
    render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );
    expect(await screen.findByText('Theirs.pdf')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('region', { name: 'Upload a document' })).toBeNull();
  });

  // The visibility note speaks to who is uploading.
  it('an outside seller reads a seller-voice visibility note, never the bank one', async () => {
    me.state = { status: 'ready', data: { user: { is_external: true } } };
    mockRoom([doc({ id: 'c', name: 'Theirs.pdf', room: 'deal' })], [], 'seller');
    render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );
    const panel = await screen.findByRole('region', { name: 'Upload a document' });
    expect(within(panel).getByText("Visible to the bank's deal team and the buyers it gives access.")).toBeInTheDocument();
    expect(within(panel).queryByText('Visible to the client and the buyers you give access.')).toBeNull();
  });

  // A stored zero-byte file never reads "0 B".
  it('a stored file of zero bytes reads "Not shown", never "0 B"', async () => {
    mockRoom([doc({ id: 'z', name: 'Empty.txt', sizeBytes: 0, hasFile: true, canOpen: true })], []);
    const { container } = render(
      <FlagsProvider value={flags(true)}>
        <DataRoomSwitch />
      </FlagsProvider>,
    );
    expect(await screen.findByText('Empty.txt')).toBeInTheDocument();
    expect(container.textContent).not.toContain('0 B');
    expect(screen.getByText('Not shown')).toBeInTheDocument();
  });
});
