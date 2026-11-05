import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import {
  ATTESTATION_TEXT,
  connectErrorCopy,
  refusedCopy,
  TEAM_INBOXES_REFRESH_MS,
  teamInboxBadge,
  NOT_IN_GROUP_NOTE,
  GROUP_UNREADABLE_NOTE,
  TeamInboxes,
  TRANSIENT_NOTE,
  utcDay,
} from '@/components/discovery/TeamInboxes';
import {
  TEAM_MAILBOX_ATTESTATION_VERSION,
  TEAM_MAILBOX_CHECK_REASONS,
  TEAM_MAILBOX_WINDOW_MAX_DAYS,
} from '@/lib/constants/discovery';
import type { TeamMailbox } from '@/lib/discovery/api';

function inbox(overrides: Partial<TeamMailbox> = {}): TeamMailbox {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    address: 'deals@bank.example',
    provider: 'google',
    connectedAt: '2026-10-18T09:00:00Z',
    checkStatus: 'verified',
    checkReason: null,
    checkedAt: '2026-10-18T09:05:00Z',
    sourceId: '00000000-0000-4000-8000-0000000000a1',
    backfillSince: null,
    lastCheckError: null,
    sourceStatus: 'active',
    removable: false,
    members: [],
    eligible: [],
    ...overrides,
  };
}

type Call = { url: string; method: string; body: unknown };

/**
 * A scripted route: GET answers `state.list` (or `state.listStatus`), POST and DELETE answer the next scripted
 * reply. Every call is recorded; a mutation changes nothing unless the test changes `state.list` itself.
 */
function stubRoute(state: {
  list: TeamMailbox[];
  listStatus?: number;
  post?: () => Response;
  del?: () => Response;
}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'POST') return Promise.resolve(state.post?.() ?? new Response('{}', { status: 201 }));
    if (method === 'DELETE') return Promise.resolve(state.del?.() ?? new Response(null, { status: 204 }));
    if (state.listStatus && state.listStatus !== 200) {
      return Promise.resolve(new Response(JSON.stringify({ error: 'x' }), { status: state.listStatus }));
    }
    return Promise.resolve(new Response(JSON.stringify({ teamMailboxes: state.list }), { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

const errorReply = (error: string, status: number) => () => new Response(JSON.stringify({ error }), { status });
const gets = (calls: Call[]) => calls.filter((c) => c.method === 'GET');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('TeamInboxes list', () => {
  it('renders nothing for a viewer the route answers 404 for', async () => {
    const { fetchMock } = stubRoute({ list: [], listStatus: 404 });
    const { container } = render(<TeamInboxes />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows an error when the first read fails', async () => {
    stubRoute({ list: [], listStatus: 500 });
    render(<TeamInboxes />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Team inboxes could not be loaded. Try again shortly.');
  });

  it('says so when no inbox is connected, and still offers the form', async () => {
    stubRoute({ list: [] });
    render(<TeamInboxes />);
    expect(await screen.findByText('No team inboxes are connected.')).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Connect a team inbox' })).toBeInTheDocument();
  });

  it('shows each state as one badge: Checking the address, Ready, Refused with its reason, Paused', async () => {
    stubRoute({
      list: [
        inbox({ id: 'a', address: 'pending@bank.example', checkStatus: 'pending', checkedAt: null }),
        inbox({ id: 'b', address: 'ready@bank.example' }),
        inbox({ id: 'c', address: 'group@bank.example', checkStatus: 'refused', checkReason: 'group' }),
        inbox({ id: 'd', address: 'paused@bank.example', sourceStatus: 'paused' }),
      ],
    });
    render(<TeamInboxes />);
    const list = await screen.findByRole('list', { name: 'Team inboxes' });
    const row = (address: string) => within(list).getByText(address).closest('li')!;

    expect(within(row('pending@bank.example')).getByText('Checking the address')).toBeInTheDocument();
    expect(within(row('ready@bank.example')).getByText('Ready')).toBeInTheDocument();
    const refused = row('group@bank.example');
    expect(within(refused).getByText('Refused')).toBeInTheDocument();
    expect(within(refused).getByText(/This is a Google Group/)).toBeInTheDocument();
    expect(within(row('paused@bank.example')).getByText('Paused')).toBeInTheDocument();
    expect(within(row('paused@bank.example')).queryByText('Ready')).not.toBeInTheDocument();
  });

  it('gives every refusal reason its own plain line, with no em dash', () => {
    const lines = TEAM_MAILBOX_CHECK_REASONS.map((reason) => refusedCopy(reason));
    expect(new Set(lines).size).toBe(TEAM_MAILBOX_CHECK_REASONS.length);
    for (const line of lines) {
      expect(line).not.toBe(refusedCopy(null));
      expect(line).not.toContain('—');
    }
    expect(refusedCopy('a_reason_from_a_newer_database')).toBe(refusedCopy(null));
  });

  it('keeps Ready and adds a retry note when the last check failed in transit', async () => {
    stubRoute({ list: [inbox({ lastCheckError: 'directory_error' })] });
    render(<TeamInboxes />);
    const row = (await screen.findByText('deals@bank.example')).closest('li')!;
    expect(within(row).getByText('Ready')).toBeInTheDocument();
    expect(within(row).getByText(TRANSIENT_NOTE)).toBeInTheDocument();
  });

  it('does not add the retry note to a refused inbox', async () => {
    stubRoute({ list: [inbox({ checkStatus: 'refused', checkReason: 'not_found', lastCheckError: 'directory_error' })] });
    render(<TeamInboxes />);
    const row = (await screen.findByText('deals@bank.example')).closest('li')!;
    expect(within(row).getByText('Not found in your Workspace.')).toBeInTheDocument();
    expect(within(row).queryByText(TRANSIENT_NOTE)).not.toBeInTheDocument();
  });

  it('shows the first-read window and the connected time', async () => {
    stubRoute({ list: [inbox({ backfillSince: '2026-10-01' })] });
    render(<TeamInboxes />);
    expect(await screen.findByText(/first read from 2026-10-01/)).toBeInTheDocument();
    expect(screen.getByText(/connected Oct 18, 2026, 9:00 AM UTC/)).toBeInTheDocument();
  });

  it('badges follow the check, and a pause only changes a verified inbox', () => {
    expect(teamInboxBadge({ checkStatus: 'pending', sourceStatus: 'paused' }).label).toBe('Checking the address');
    expect(teamInboxBadge({ checkStatus: 'refused', sourceStatus: 'paused' }).label).toBe('Refused');
    expect(teamInboxBadge({ checkStatus: 'verified', sourceStatus: 'paused' }).label).toBe('Paused');
    expect(teamInboxBadge({ checkStatus: 'verified', sourceStatus: null }).label).toBe('Ready');
    // Audit item 3: a verified inbox the worker was refused for not being in the ingest group is never Ready.
    expect(teamInboxBadge({ checkStatus: 'verified', sourceStatus: 'active', readRefusal: 'not_in_provider_group' })).toEqual({
      label: 'Not in the ingest group',
      tone: 'negative',
    });
    expect(teamInboxBadge({ checkStatus: 'verified', sourceStatus: 'paused', readRefusal: 'not_in_provider_group' }).label).toBe('Paused');
    // The group could not be read, so nothing was: a distinct state, never Ready.
    expect(teamInboxBadge({ checkStatus: 'verified', sourceStatus: 'active', readRefusal: 'mirror_unavailable' })).toEqual({
      label: "Can't read the ingest group",
      tone: 'hold',
    });
    expect(teamInboxBadge({ checkStatus: 'verified', sourceStatus: 'paused', readRefusal: 'mirror_unavailable' }).label).toBe('Paused');
    expect(teamInboxBadge({ checkStatus: 'verified', sourceStatus: 'active', readRefusal: null }).label).toBe('Ready');
  });

  it('says a verified inbox is not read while the ingest group cannot be read', async () => {
    stubRoute({ list: [inbox({ readRefusal: 'mirror_unavailable' })] });
    render(<TeamInboxes />);
    const row = (await screen.findByText('deals@bank.example')).closest('li')!;
    expect(within(row).getByText("Can't read the ingest group")).toBeInTheDocument();
    expect(within(row).queryByText('Ready')).not.toBeInTheDocument();
    expect(within(row).getByText(GROUP_UNREADABLE_NOTE)).toBeInTheDocument();
    expect(within(row).queryByText(NOT_IN_GROUP_NOTE)).not.toBeInTheDocument();
    expect(GROUP_UNREADABLE_NOTE).not.toContain('—');
  });

  it('says a verified inbox outside the ingest group is not read, and what the Workspace admin does', async () => {
    stubRoute({ list: [inbox({ readRefusal: 'not_in_provider_group' })] });
    render(<TeamInboxes />);
    const row = (await screen.findByText('deals@bank.example')).closest('li')!;
    expect(within(row).getByText('Not in the ingest group')).toBeInTheDocument();
    expect(within(row).queryByText('Ready')).not.toBeInTheDocument();
    expect(within(row).getByText(NOT_IN_GROUP_NOTE)).toBeInTheDocument();
    expect(NOT_IN_GROUP_NOTE).not.toContain('—');
  });

  it('refetches on the timer and keeps the card, with a note, when a refetch fails', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const state = { list: [inbox()], listStatus: 200 };
    const { calls } = stubRoute(state);
    render(<TeamInboxes />);
    await screen.findByText('deals@bank.example');
    expect(gets(calls)).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(TEAM_INBOXES_REFRESH_MS);
    });
    await waitFor(() => expect(gets(calls)).toHaveLength(2));
    // Let the second read finish: a tick that lands while a read is running is skipped.
    await new Promise((resolve) => setTimeout(resolve, 20));

    state.listStatus = 500;
    await act(async () => {
      vi.advanceTimersByTime(TEAM_INBOXES_REFRESH_MS);
    });
    expect(await screen.findByText('Could not refresh, retrying.')).toBeInTheDocument();
    expect(screen.getByText('deals@bank.example')).toBeInTheDocument();
  });
});

describe('TeamInboxes connect', () => {
  async function fill(address: string) {
    fireEvent.change(await screen.findByLabelText('Team inbox address'), { target: { value: address } });
  }
  const submitButton = () => screen.getByRole('button', { name: 'Connect team inbox' });

  it('needs an address and the ticked attestation before it can submit', async () => {
    stubRoute({ list: [] });
    render(<TeamInboxes />);
    await fill('deals@bank.example');
    expect(submitButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: ATTESTATION_TEXT }));
    expect(submitButton()).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Team inbox address'), { target: { value: '  ' } });
    expect(submitButton()).toBeDisabled();
  });

  it('posts the address, the attestation version and the window, then refetches and clears the form', async () => {
    const state = { list: [] as TeamMailbox[], post: () => new Response('{"teamMailbox":{}}', { status: 201 }) };
    const { calls } = stubRoute(state);
    render(<TeamInboxes />);
    await fill(' deals@bank.example ');
    fireEvent.change(screen.getByLabelText(/First read from/), { target: { value: '2026-10-01' } });
    fireEvent.click(screen.getByRole('checkbox', { name: ATTESTATION_TEXT }));
    state.list = [inbox({ checkStatus: 'pending', checkedAt: null })];
    fireEvent.click(submitButton());

    expect(await screen.findByText('Checking the address')).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/v1/discovery/team-mailboxes');
    expect(post.body).toEqual({
      address: 'deals@bank.example',
      attestationVersion: TEAM_MAILBOX_ATTESTATION_VERSION,
      backfillSince: '2026-10-01',
    });
    expect(gets(calls)).toHaveLength(2);
    expect(screen.getByLabelText('Team inbox address')).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: ATTESTATION_TEXT })).not.toBeChecked();
  });

  it('leaves the window out of the body when none is chosen', async () => {
    const { calls } = stubRoute({ list: [] });
    render(<TeamInboxes />);
    await fill('deals@bank.example');
    fireEvent.click(screen.getByRole('checkbox', { name: ATTESTATION_TEXT }));
    fireEvent.click(submitButton());
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      address: 'deals@bank.example',
      attestationVersion: TEAM_MAILBOX_ATTESTATION_VERSION,
    });
  });

  it('says so when the address was already connected (200)', async () => {
    stubRoute({ list: [inbox()], post: () => new Response('{"teamMailbox":{}}', { status: 200 }) });
    render(<TeamInboxes />);
    await fill('deals@bank.example');
    fireEvent.click(screen.getByRole('checkbox', { name: ATTESTATION_TEXT }));
    fireEvent.click(submitButton());
    expect(await screen.findByText('That address is already connected.')).toBeInTheDocument();
  });

  it.each([
    ['not_eligible', 403, 'Only the firm admin can connect a team inbox.'],
    ['person_address', 409, "This is a person's address. They connect it themselves from their profile."],
    ['provider_unresolved', 422, /cannot tell which mail provider/],
    ['provider_unsupported', 422, 'Team inboxes on Microsoft 365 are not available yet.'],
    ['out_of_range', 422, /within the last 730 days/],
    ['invalid_address', 422, /Enter a full email address/],
    ['attestation_required', 422, /Reload the page and confirm again/],
    ['anything else', 500, 'The team inbox could not be connected. Try again shortly.'],
  ])('shows the inline error for %s (%i) and keeps what was typed', async (code, status, copy) => {
    stubRoute({ list: [], post: errorReply(code, status) });
    render(<TeamInboxes />);
    await fill('deals@bank.example');
    fireEvent.click(screen.getByRole('checkbox', { name: ATTESTATION_TEXT }));
    fireEvent.click(submitButton());
    const alert = await screen.findByRole('alert');
    if (typeof copy === 'string') expect(alert).toHaveTextContent(copy);
    else expect(alert.textContent).toMatch(copy as RegExp);
    expect(screen.getByLabelText('Team inbox address')).toHaveValue('deals@bank.example');
    expect(submitButton()).toBeEnabled();
  });

  it('has a line for every refusal the route names, and none with an em dash', () => {
    for (const code of [
      'not_eligible',
      'person_address',
      'provider_unresolved',
      'provider_unsupported',
      'out_of_range',
      'invalid_address',
      'attestation_required',
    ]) {
      const line = connectErrorCopy(422, code);
      expect(line).not.toBe(connectErrorCopy(500, undefined));
      expect(line).not.toContain('—');
    }
    expect(connectErrorCopy(400, 'address is required')).toMatch(/Check the address/);
    expect(ATTESTATION_TEXT).not.toContain('—');
  });

  it('bounds the window from today back 730 days, in UTC', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
    stubRoute({ list: [] });
    render(<TeamInboxes />);
    const input = await screen.findByLabelText(/First read from/);
    expect(input).toHaveAttribute('type', 'date');
    expect(input).toHaveAttribute('max', '2026-10-18');
    expect(input).toHaveAttribute('min', '2024-10-18');
    expect(utcDay(Date.parse('2026-10-18T23:30:00Z'))).toBe('2026-10-18');
    expect(TEAM_MAILBOX_WINDOW_MAX_DAYS).toBe(730);
  });
});

describe('TeamInboxes remove', () => {
  it('offers Remove only on a removable inbox', async () => {
    stubRoute({
      list: [
        inbox({ id: 'a', address: 'empty@bank.example', checkStatus: 'refused', checkReason: 'group', removable: true }),
        inbox({ id: 'b', address: 'live@bank.example' }),
      ],
    });
    render(<TeamInboxes />);
    const list = await screen.findByRole('list', { name: 'Team inboxes' });
    expect(within(list).getAllByRole('button', { name: /^Remove / })).toHaveLength(1);
    expect(within(within(list).getByText('live@bank.example').closest('li')!).queryByRole('button')).toBeNull();
  });

  it('asks first, then deletes the registration and refetches', async () => {
    const state = {
      list: [inbox({ id: 'a', checkStatus: 'refused', checkReason: 'group', removable: true })],
    };
    const { calls } = stubRoute(state);
    render(<TeamInboxes />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove deals@bank.example' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(screen.getByText(/Nothing has been read from this inbox/)).toBeInTheDocument();

    state.list = [];
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removal of deals@bank.example' }));
    expect(await screen.findByText('No team inboxes are connected.')).toBeInTheDocument();
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.url).toBe('/api/v1/discovery/team-mailboxes/a');
  });

  it('cancels without deleting', async () => {
    const { calls } = stubRoute({ list: [inbox({ removable: true })] });
    render(<TeamInboxes />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove deals@bank.example' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel removal of deals@bank.example' }));
    expect(screen.getByRole('button', { name: 'Remove deals@bank.example' })).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('says so and refetches when the inbox can no longer be removed (409)', async () => {
    const state = { list: [inbox({ removable: true })], del: errorReply('not_removable', 409) };
    const { calls } = stubRoute(state);
    render(<TeamInboxes />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove deals@bank.example' }));
    state.list = [inbox({ removable: false })];
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removal of deals@bank.example' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This inbox holds mail now, so it can no longer be removed.',
    );
    await waitFor(() => expect(gets(calls)).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull());
  });

  it('shows an error and keeps the inbox when the delete fails', async () => {
    stubRoute({ list: [inbox({ removable: true })], del: errorReply('x', 500) });
    render(<TeamInboxes />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove deals@bank.example' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removal of deals@bank.example' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The inbox could not be removed. Try again shortly.');
    expect(screen.getByText('deals@bank.example')).toBeInTheDocument();
  });
});

describe('TeamInboxes people with access', () => {
  const INBOX_ID = '00000000-0000-4000-8000-000000000001';
  const storm = { userId: 'u-storm', name: 'Storm Duncan', email: 'storm@bank.example' };
  const bob = { userId: 'u-bob', name: 'Bob Ng', email: 'bob@bank.example' };
  const cara = { userId: 'u-cara', name: 'Cara Diaz', email: 'cara@bank.example' };
  const withStorm = { ...storm, addedAt: '2026-10-18T10:00:00Z' };
  const membersUrl = `/api/v1/discovery/team-mailboxes/${INBOX_ID}/members`;

  const picker = () => screen.getByLabelText('Add a person') as HTMLSelectElement;
  const optionLabels = () => within(picker()).getAllByRole('option').map((o) => o.textContent);

  it('lists the people with access, by name and address', async () => {
    stubRoute({ list: [inbox({ members: [withStorm], eligible: [storm, bob] })] });
    render(<TeamInboxes />);
    const list = await screen.findByRole('list', { name: 'People with access' });
    expect(within(list).getByText('Storm Duncan')).toBeInTheDocument();
    expect(within(list).getByText('storm@bank.example')).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  });

  it('offers the eligible colleagues who are not already members', async () => {
    stubRoute({ list: [inbox({ members: [withStorm], eligible: [storm, bob, cara] })] });
    render(<TeamInboxes />);
    await screen.findByRole('list', { name: 'People with access' });
    expect(optionLabels()).toEqual([
      'Choose a colleague',
      'Bob Ng (bob@bank.example)',
      'Cara Diaz (cara@bank.example)',
    ]);
  });

  it('keeps a member who is no longer eligible (promoted to admin) listed, so they can be removed', async () => {
    stubRoute({ list: [inbox({ members: [withStorm], eligible: [bob] })] });
    render(<TeamInboxes />);
    expect(await screen.findByRole('button', { name: 'Remove Storm Duncan from deals@bank.example' })).toBeInTheDocument();
    expect(optionLabels()).toEqual(['Choose a colleague', 'Bob Ng (bob@bank.example)']);
  });

  it('cannot add until a colleague is chosen, then posts the userId and refetches', async () => {
    const state = {
      list: [inbox({ eligible: [storm, bob] })],
      post: () => new Response('{"member":{}}', { status: 201 }),
    };
    const { calls } = stubRoute(state);
    render(<TeamInboxes />);
    await screen.findByLabelText('Add a person');
    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();

    fireEvent.change(picker(), { target: { value: 'u-storm' } });
    expect(add).toBeEnabled();
    state.list = [inbox({ members: [withStorm], eligible: [storm, bob] })];
    fireEvent.click(add);

    const list = await screen.findByRole('list', { name: 'People with access' });
    expect(within(list).getByText('Storm Duncan')).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe(membersUrl);
    expect(post.body).toEqual({ userId: 'u-storm' });
    expect(gets(calls)).toHaveLength(2);
    expect(optionLabels()).toEqual(['Choose a colleague', 'Bob Ng (bob@bank.example)']);
    expect(picker()).toHaveValue('');
  });

  it('treats a person who already is a member (200) as added', async () => {
    const state = {
      list: [inbox({ eligible: [storm] })],
      post: () => new Response('{"member":{}}', { status: 200 }),
    };
    const { calls } = stubRoute(state);
    render(<TeamInboxes />);
    await screen.findByLabelText('Add a person');
    fireEvent.change(picker(), { target: { value: 'u-storm' } });
    state.list = [inbox({ members: [withStorm], eligible: [storm] })];
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('list', { name: 'People with access' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(gets(calls)).toHaveLength(2);
  });

  it('says so and refetches when the person can no longer be added (422)', async () => {
    const state = {
      list: [inbox({ eligible: [storm, bob] })],
      post: errorReply('not_eligible_member', 422),
    };
    const { calls } = stubRoute(state);
    render(<TeamInboxes />);
    await screen.findByLabelText('Add a person');
    fireEvent.change(picker(), { target: { value: 'u-storm' } });
    state.list = [inbox({ eligible: [bob] })];
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/This person cannot be added/);
    await waitFor(() => expect(gets(calls)).toHaveLength(2));
    await waitFor(() => expect(optionLabels()).toEqual(['Choose a colleague', 'Bob Ng (bob@bank.example)']));
    expect(picker()).toHaveValue('');
  });

  it('shows a plain error and keeps the choice when adding fails', async () => {
    const { calls } = stubRoute({ list: [inbox({ eligible: [storm] })], post: errorReply('x', 500) });
    render(<TeamInboxes />);
    await screen.findByLabelText('Add a person');
    fireEvent.change(picker(), { target: { value: 'u-storm' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The person could not be added. Try again shortly.');
    expect(picker()).toHaveValue('u-storm');
    expect(gets(calls)).toHaveLength(1);
  });

  it('asks first, then removes the person and refetches', async () => {
    const state = { list: [inbox({ members: [withStorm], eligible: [storm] })] };
    const { calls } = stubRoute(state);
    render(<TeamInboxes />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Storm Duncan from deals@bank.example' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(screen.getByText(/Storm Duncan will stop seeing what this inbox finds/)).toBeInTheDocument();

    state.list = [inbox({ members: [], eligible: [storm] })];
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removal of Storm Duncan from deals@bank.example' }));
    expect(await screen.findByText(/No one has access yet/)).toBeInTheDocument();
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.url).toBe(`${membersUrl}/u-storm`);
    expect(optionLabels()).toEqual(['Choose a colleague', 'Storm Duncan (storm@bank.example)']);
  });

  it('cancels a removal without deleting', async () => {
    const { calls } = stubRoute({ list: [inbox({ members: [withStorm], eligible: [storm] })] });
    render(<TeamInboxes />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Storm Duncan from deals@bank.example' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel removal of Storm Duncan from deals@bank.example' }));
    expect(screen.getByRole('button', { name: 'Remove Storm Duncan from deals@bank.example' })).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('keeps the person and says so when the removal fails', async () => {
    stubRoute({ list: [inbox({ members: [withStorm], eligible: [storm] })], del: errorReply('x', 500) });
    render(<TeamInboxes />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Storm Duncan from deals@bank.example' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removal of Storm Duncan from deals@bank.example' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The person could not be removed. Try again shortly.');
    expect(screen.getByText('Storm Duncan')).toBeInTheDocument();
  });

  it('refetches without an error when the inbox is already gone (404)', async () => {
    const { calls } = stubRoute({
      list: [inbox({ members: [withStorm], eligible: [storm] })],
      del: errorReply('Not found', 404),
    });
    render(<TeamInboxes />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Storm Duncan from deals@bank.example' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removal of Storm Duncan from deals@bank.example' }));
    await waitFor(() => expect(gets(calls)).toHaveLength(2));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says why nobody can be added: no eligible colleague, or everyone already has access', async () => {
    stubRoute({
      list: [
        inbox({ id: 'a', address: 'none@bank.example', members: [], eligible: [] }),
        inbox({ id: 'b', address: 'all@bank.example', members: [withStorm], eligible: [storm] }),
      ],
    });
    render(<TeamInboxes />);
    const list = await screen.findByRole('list', { name: 'Team inboxes' });
    const none = within(list).getByText('none@bank.example').closest('li')!;
    const all = within(list).getByText('all@bank.example').closest('li')!;

    expect(within(none).getByText(/No one has access yet/)).toBeInTheDocument();
    expect(within(none).getByText(/No colleagues can be added yet/)).toBeInTheDocument();
    expect(within(none).queryByRole('combobox')).toBeNull();
    expect(within(all).getByText('Everyone who can be added already has access.')).toBeInTheDocument();
    expect(within(all).queryByRole('combobox')).toBeNull();
    expect(within(all).queryByRole('button', { name: 'Add' })).toBeNull();
  });

  it('keeps each inbox its own people, and no copy has an em dash', async () => {
    stubRoute({
      list: [
        inbox({ id: 'a', address: 'one@bank.example', members: [withStorm], eligible: [storm, bob] }),
        inbox({ id: 'b', address: 'two@bank.example', members: [], eligible: [storm, bob] }),
      ],
    });
    const { container } = render(<TeamInboxes />);
    const list = await screen.findByRole('list', { name: 'Team inboxes' });
    const one = within(list).getByText('one@bank.example').closest('li')!;
    const two = within(list).getByText('two@bank.example').closest('li')!;
    expect(within(one).getByText('Storm Duncan')).toBeInTheDocument();
    expect(within(two).queryByText('Storm Duncan')).toBeNull();
    expect(within(two).getByRole('combobox')).toHaveTextContent('Storm Duncan (storm@bank.example)');
    expect(container.textContent).not.toContain('—');
  });
});
