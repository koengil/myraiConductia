import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import {
  ageLabel,
  countsLabel,
  dateLabel,
  delegationBadge,
  excludedLabel,
  groupBadge,
  HEALTH_REFRESH_MS,
  IngestionHealth,
  lastErrorLabel,
  passBadge,
  passCountsLabel,
  passTimeLabel,
  passTotalsLabel,
  policyVersionLabel,
  readerLine,
  restartScopeLabel,
  sourceKindLabel,
  sourceLabel,
  sourceStateBadge,
  sourceStateReason,
  timeLabel,
  updatedLabel,
  utcDateIso,
  waitingLabel,
  WINDOW_FAILURE,
  WINDOW_LONG_HINT,
  windowBounds,
  windowLabel,
} from '@/components/discovery/IngestionHealth';
import { HISTORY_WINDOW_EXCEEDED, HISTORY_WINDOW_HALT_DAYS, READER_HEALTH_STATES, SOURCE_HEALTH_STATES, SOURCE_REFUSAL_REASONS } from '@/lib/constants/discovery';
import type { IngestionHealth as Health, ReaderHealth, ReaderPassHealth, ReaderPassTotals } from '@/lib/discovery/api';

const HEALTH: Health = {
  registration: { status: 'active', consentedAt: '2026-09-20T10:00:00Z' },
  registrations: [
    { provider: 'microsoft', status: 'active', consentedAt: '2026-09-20T10:00:00Z', delegationStatus: null, delegationCheckedAt: null },
  ],
  allowlist: [],
  viewerCanManageSources: false,
  reconciliation: 'not_built',
  sources: [
    {
      id: 's-mail',
      kind: 'mailbox',
      provider: 'microsoft',
      checkpointAgeSeconds: 120,
      waitingFor: null,
      address: 'storm.duncan@bank.example',
      status: 'active',
      archived: false,
      ownerAssigned: true,
      checkpointState: 'incremental',
      backfillCompletedAt: '2026-09-21T09:00:00Z',
      checkpointUpdatedAt: '2026-09-25T09:00:00Z',
      lastSyncedAt: '2026-09-25T09:00:00Z',
      lastError: null,
      lastErrorAt: null,
      itemsLedgered: 120,
      itemsRouted: 14,
      itemsSkipped: 0,
    },
    {
      id: 's-site',
      kind: 'sharepoint_site',
      provider: 'microsoft',
      checkpointAgeSeconds: 240,
      waitingFor: null,
      address: 'bank.sharepoint.com,site,web',
      status: 'active',
      archived: false,
      ownerAssigned: false,
      checkpointState: 'backfilling',
      backfillCompletedAt: null,
      checkpointUpdatedAt: '2026-09-25T09:04:00Z',
      lastSyncedAt: null,
      lastError: 'Graph 429 TooManyRequests (throttled)',
      lastErrorAt: '2026-09-25T09:05:00Z',
      itemsLedgered: 40,
      itemsRouted: 3,
      itemsSkipped: 5,
    },
  ],
  totals: { sources: 2, itemsLedgered: 160, itemsRouted: 17, itemsSkipped: 5, itemsStored: 16, candidatesProposed: 2 },
};

function stubFetch(response: Promise<Response> | Response) {
  const fetchMock = vi.fn(() => Promise.resolve(response));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** One response per call, in order (a fresh Response each time); the last repeats. Records every call. */
function sequenceFetch(...replies: Array<() => Response>) {
  let call = 0;
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    void url;
    void init;
    const reply = replies[Math.min(call, replies.length - 1)]!;
    call += 1;
    return Promise.resolve(reply());
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const healthReply = (health: Health) => () => new Response(JSON.stringify({ health }), { status: 200 });
const jsonReply = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('IngestionHealth', () => {
  it('shows a loading state, then each source with its sync state and counts', async () => {
    let resolve!: (value: Response) => void;
    const fetchMock = stubFetch(new Promise<Response>((r) => (resolve = r)));
    render(<IngestionHealth />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading ingestion health');
    resolve(new Response(JSON.stringify({ health: HEALTH }), { status: 200 }));

    const list = await screen.findByRole('list', { name: 'Content sources' });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/discovery/health', expect.anything());
    expect(screen.getByText('Microsoft 365 mail reading is on')).toBeInTheDocument();
    expect(
      screen.getByText('2 sources, 160 items read, 17 routed, 16 stored, 2 proposed deals.'),
    ).toBeInTheDocument();

    const mail = within(list).getByText('storm.duncan@bank.example').closest('li')!;
    expect(within(mail).getByText('Up to date')).toBeInTheDocument();
    expect(within(mail).getByText('Microsoft 365 mailbox')).toBeInTheDocument();
    expect(within(mail).getByText('2 min ago')).toBeInTheDocument();
    expect(within(mail).queryByText('Stale')).not.toBeInTheDocument();
    expect(within(mail).getByText('120 read, 14 routed')).toBeInTheDocument();
    expect(within(mail).getByText('Sep 25, 2026, 9:00 AM UTC')).toBeInTheDocument();

    const site = within(list).getByText('bank.sharepoint.com,site,web').closest('li')!;
    expect(within(site).getByText('Backfilling')).toBeInTheDocument();
    expect(within(site).getByText('SharePoint site, no owner assigned')).toBeInTheDocument();
    expect(within(site).getByText('40 read, 3 routed, 5 skipped')).toBeInTheDocument();
    expect(within(site).getByText(/Graph 429 TooManyRequests \(throttled\)/)).toBeInTheDocument();
    expect(within(site).getByText('Never')).toBeInTheDocument();
  });

  it('renders nothing for a viewer the route does not answer (404)', async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }));
    const { container } = render(<IngestionHealth />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows an error when the route fails', async () => {
    stubFetch(new Response(JSON.stringify({ error: 'x' }), { status: 500 }));
    render(<IngestionHealth />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Ingestion health could not be loaded. Try again shortly.');
  });

  it('says so when no source is configured', async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          health: {
            registration: null,
            sources: [],
            totals: { sources: 0, itemsLedgered: 0, itemsRouted: 0, itemsSkipped: 0, itemsStored: 0, candidatesProposed: 0 },
          },
        }),
        { status: 200 },
      ),
    );
    render(<IngestionHealth />);
    expect(await screen.findByText('No content sources are configured.')).toBeInTheDocument();
    expect(screen.getByText('Mail reading is not set up')).toBeInTheDocument();
  });
});

const GOOGLE_SOURCE: Health['sources'][number] = {
  id: 's-gmail',
  kind: 'mailbox',
  provider: 'google',
  address: 'storm.duncan@bank.example',
  status: 'active',
  archived: false,
  ownerAssigned: true,
  checkpointState: 'incremental',
  backfillCompletedAt: '2026-10-21T09:00:00Z',
  checkpointUpdatedAt: '2026-10-21T09:10:00Z',
  checkpointAgeSeconds: 120,
  lastSyncedAt: '2026-10-21T09:10:00Z',
  lastError: null,
  lastErrorAt: null,
  waitingFor: null,
  itemsLedgered: 30,
  itemsRouted: 4,
  itemsSkipped: 0,
};

function googleHealth(overrides: Partial<Health> = {}, source: Partial<Health['sources'][number]> = {}): Health {
  return {
    ...HEALTH,
    registrations: [
      { provider: 'google', status: 'active', consentedAt: '2026-10-20T10:00:00Z', delegationStatus: 'ok', delegationCheckedAt: '2026-10-21T09:00:00Z' },
    ],
    allowlist: [{ provider: 'google', status: 'in_sync', missingCount: 0, extraCount: 0, checkedAt: '2026-10-21T09:05:00Z' }],
    viewerCanManageSources: true,
    sources: [{ ...GOOGLE_SOURCE, ...source }],
    totals: { ...HEALTH.totals, sources: 1 },
    ...overrides,
  };
}

function showHealth(health: Health) {
  return stubFetch(new Response(JSON.stringify({ health }), { status: 200 }));
}

describe('IngestionHealth, Google', () => {
  it('shows the delegation and group state, and Reconciliation not built yet, never a clean reading', async () => {
    showHealth(googleHealth());
    const { container } = render(<IngestionHealth />);
    const registrations = await screen.findByRole('list', { name: 'Mail reading by provider' });
    const line = within(registrations).getByText('Google Workspace mail reading is on').closest('li')!;
    expect(within(line).getByText('Access approved by your admin')).toBeInTheDocument();
    expect(within(line).getByText('Group in sync')).toBeInTheDocument();
    expect(within(line).getByText('Approval checked Oct 21, 2026, 9:00 AM UTC')).toBeInTheDocument();
    expect(screen.getByText('Reconciliation not built yet')).toBeInTheDocument();
    expect(container.textContent ?? '').not.toMatch(/clean/i);
  });

  it('says so when delegation is missing, when the check failed, and before any check', async () => {
    for (const [delegationStatus, label] of [
      ['missing', 'Access not approved by your admin'],
      ['error', 'Approval check failed'],
      [null, 'Not checked yet'],
    ] as const) {
      showHealth(
        googleHealth({
          registrations: [{ provider: 'google', status: 'active', consentedAt: null, delegationStatus, delegationCheckedAt: null }],
        }),
      );
      const { unmount } = render(<IngestionHealth />);
      const line = (await screen.findByText('Google Workspace mail reading is on')).closest('li')!;
      expect(within(line).getByText(label)).toBeInTheDocument();
      unmount();
      vi.unstubAllGlobals();
    }
  });

  it('shows group drift with counts, and an unreadable group', async () => {
    showHealth(googleHealth({ allowlist: [{ provider: 'google', status: 'drift', missingCount: 2, extraCount: 1, checkedAt: null }] }));
    const first = render(<IngestionHealth />);
    const line = (await screen.findByText('Google Workspace mail reading is on')).closest('li')!;
    expect(within(line).getByText('Group drift')).toBeInTheDocument();
    expect(within(line).getByText('2 missing from the group, 1 extra in the group')).toBeInTheDocument();
    first.unmount();
    vi.unstubAllGlobals();

    showHealth(googleHealth({ allowlist: [{ provider: 'google', status: 'unavailable', missingCount: 0, extraCount: 0, checkedAt: null }] }));
    render(<IngestionHealth />);
    expect(await screen.findByText('Group unreadable')).toBeInTheDocument();
  });

  it('shows the source state in place of the checkpoint badge, with the checkpoint age beside it', async () => {
    showHealth(googleHealth({}, { state: 'stale', lastPassAgeSeconds: 1_260, checkpointAgeSeconds: 41 * 60 }));
    render(<IngestionHealth />);
    const row = (await screen.findByText('storm.duncan@bank.example')).closest('li')!;
    expect(within(row).getByText('Stale')).toBeInTheDocument();
    expect(within(row).queryByText('Up to date')).not.toBeInTheDocument();
    expect(within(row).getByText('Gmail mailbox')).toBeInTheDocument();
    expect(within(row).getByText('41 min ago')).toBeInTheDocument();
  });

  it('says why a mailbox is waiting, in plain words', async () => {
    showHealth(googleHealth({}, { waitingFor: 'not_in_provider_group', checkpointState: 'not_started', checkpointAgeSeconds: null, backfillCompletedAt: null }));
    render(<IngestionHealth />);
    const row = (await screen.findByText('storm.duncan@bank.example')).closest('li')!;
    expect(within(row).getByText('Not matched to one member of the group')).toBeInTheDocument();
    expect(within(row).queryByText('Stale')).not.toBeInTheDocument();
  });

  it('pauses through the source status route, then the refetched health drives the badge and Resume', async () => {
    const fetchMock = sequenceFetch(
      healthReply(googleHealth({}, { waitingFor: 'no_consent', state: 'waiting' })),
      jsonReply({ id: 's-gmail', status: 'paused', changed: true }),
      healthReply(googleHealth({}, { status: 'paused', waitingFor: null, state: 'paused' })),
    );
    render(<IngestionHealth />);
    expect(await screen.findByText('Waiting for access')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause reading storm.duncan@bank.example' }));

    const resume = await screen.findByRole('button', { name: 'Resume reading storm.duncan@bank.example' });
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(patch[0]).toBe('/api/v1/discovery/sources/s-gmail/status');
    expect(JSON.parse(String(patch[1]?.body))).toEqual({ status: 'paused' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/discovery/health',
      '/api/v1/discovery/sources/s-gmail/status',
      '/api/v1/discovery/health',
    ]);
    const row = resume.closest('li')!;
    expect(within(row).getByText('Gmail mailbox, paused')).toBeInTheDocument();
    expect(within(row).getByText('Paused')).toBeInTheDocument();
    expect(within(row).queryByText('Waiting for access')).not.toBeInTheDocument();
    expect(within(row).queryByText("Waiting for the user's consent")).not.toBeInTheDocument();
  });

  it('keeps the source as it was and says so when the change fails, without refetching', async () => {
    const fetchMock = sequenceFetch(healthReply(googleHealth()), jsonReply({ error: 'Not found' }, 404));
    render(<IngestionHealth />);
    fireEvent.click(await screen.findByRole('button', { name: /Pause reading/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The change could not be saved. Try again shortly.');
    await waitFor(() => expect(screen.getByRole('button', { name: /Pause reading/ })).toBeEnabled());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the card it had when the refetch after a control fails', async () => {
    sequenceFetch(
      healthReply(googleHealth()),
      jsonReply({ id: 's-gmail', status: 'paused', changed: true }),
      jsonReply({ error: 'x' }, 500),
    );
    render(<IngestionHealth />);
    fireEvent.click(await screen.findByRole('button', { name: /Pause reading/ }));
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole('button', { name: /Pause reading/ })).toBeEnabled());
    expect(screen.getByText('storm.duncan@bank.example')).toBeInTheDocument();
    expect(screen.queryByText('Ingestion health could not be loaded. Try again shortly.')).not.toBeInTheDocument();
    // The old card stays, and says its data may be behind (S2).
    expect(screen.getByRole('status')).toHaveTextContent('Could not refresh, retrying.');
  });

  it('offers no pause control to the control room, or on a Microsoft source', async () => {
    showHealth(googleHealth({ viewerCanManageSources: false }));
    const cco = render(<IngestionHealth />);
    await screen.findByText('storm.duncan@bank.example');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    cco.unmount();
    vi.unstubAllGlobals();

    showHealth({ ...HEALTH, viewerCanManageSources: true });
    render(<IngestionHealth />);
    await screen.findByText('storm.duncan@bank.example');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders no subject, body or participant: only what the payload carries', async () => {
    // The payload has no such field; the view must not invent one. A canary in an
    // unknown field of the payload is never rendered.
    const payload = googleHealth({}, { ...({ subject: 'Project Falcon: kickoff', body: 'Falcon body text' } as object) });
    showHealth(payload);
    const { container } = render(<IngestionHealth />);
    await screen.findByText('storm.duncan@bank.example');
    expect(container.textContent ?? '').not.toMatch(/falcon/i);
  });

  it('offers no pause or resume on an archived source, and says it is archived', async () => {
    showHealth(googleHealth({}, { archived: true, status: 'paused', waitingFor: null, address: 'gone@bank.example~abc' }));
    render(<IngestionHealth />);
    const row = (await screen.findByText('gone@bank.example~abc')).closest('li')!;
    expect(within(row).getByText('Gmail mailbox, archived')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the no-registration shape (empty keys) without a panel of lines', async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          health: {
            registration: null,
            registrations: [],
            allowlist: [],
            sources: [],
            viewerCanManageSources: false,
            reconciliation: 'not_built',
            totals: { sources: 0, itemsLedgered: 0, itemsRouted: 0, itemsSkipped: 0, itemsStored: 0, candidatesProposed: 0 },
          },
        }),
        { status: 200 },
      ),
    );
    render(<IngestionHealth />);
    expect(await screen.findByText('Mail reading is not set up.')).toBeInTheDocument();
    expect(screen.getByText('No content sources are configured.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps the legacy single registration line when the payload predates the per-provider list', async () => {
    const legacy = { ...HEALTH } as Partial<Health>;
    delete legacy.registrations;
    delete legacy.allowlist;
    delete legacy.reconciliation;
    stubFetch(new Response(JSON.stringify({ health: legacy }), { status: 200 }));
    render(<IngestionHealth />);
    expect(await screen.findByText('Mail reading is on')).toBeInTheDocument();
    expect(screen.queryByText('Reconciliation not built yet')).not.toBeInTheDocument();
  });
});

describe('IngestionHealth, exclusion policy (#263)', () => {
  const withPolicy = (
    totals: Partial<Health['totals']>,
    source: Partial<Health['sources'][number]>,
    policyVersion: number | null,
  ): Health => ({
    ...googleHealth({}, source),
    policyVersion,
    totals: { ...HEALTH.totals, sources: 1, ...totals },
  });

  it('shows the excluded count on the source and in the totals, and the version as its own line', async () => {
    showHealth(withPolicy({ itemsExcluded: 2, itemsSkipped: 2 }, { itemsExcluded: 2, itemsSkipped: 2 }, 1));
    render(<IngestionHealth />);
    const row = (await screen.findByText('storm.duncan@bank.example')).closest('li')!;
    expect(within(row).getByText('30 read, 4 routed, 2 excluded by policy')).toBeInTheDocument();
    expect(screen.getByText('1 source, 160 items read, 17 routed, 2 excluded by policy, 16 stored, 2 proposed deals.')).toBeInTheDocument();
    expect(screen.getByText('Exclusion policy v1')).toBeInTheDocument();
  });

  it('keeps the policy skips apart from the other skips, so nothing is counted twice', async () => {
    showHealth(withPolicy({ itemsExcluded: 2, itemsSkipped: 5 }, { itemsExcluded: 2, itemsSkipped: 5 }, 1));
    render(<IngestionHealth />);
    const row = (await screen.findByText('storm.duncan@bank.example')).closest('li')!;
    expect(within(row).getByText('30 read, 4 routed, 2 excluded by policy, 3 skipped')).toBeInTheDocument();
  });

  it('shows no excluded line at zero, and no version line without a version', async () => {
    showHealth(withPolicy({ itemsExcluded: 0 }, { itemsExcluded: 0 }, null));
    const { container } = render(<IngestionHealth />);
    const row = (await screen.findByText('storm.duncan@bank.example')).closest('li')!;
    expect(within(row).getByText('30 read, 4 routed')).toBeInTheDocument();
    expect(container.textContent ?? '').not.toMatch(/excluded by policy/);
    expect(container.textContent ?? '').not.toMatch(/Exclusion policy/);
  });

  it('shows the version without an excluded line when a policy exists and nothing was excluded', async () => {
    showHealth(withPolicy({ itemsExcluded: 0 }, { itemsExcluded: 0 }, 3));
    const { container } = render(<IngestionHealth />);
    expect(await screen.findByText('Exclusion policy v3')).toBeInTheDocument();
    expect(container.textContent ?? '').not.toMatch(/excluded by policy/);
  });

  it('never fuses the historical count with the current version', async () => {
    showHealth(withPolicy({ itemsExcluded: 10, itemsSkipped: 10 }, { itemsExcluded: 10, itemsSkipped: 10 }, 2));
    const { container } = render(<IngestionHealth />);
    expect(await screen.findByText('Exclusion policy v2')).toBeInTheDocument();
    const text = container.textContent ?? '';
    expect(text).toContain('10 excluded by policy');
    expect(text).not.toMatch(/excluded by policy,? ?v\d/);
    expect(text).not.toMatch(/excluded by policy v/i);
    expect(screen.getByText('Exclusion policy v2').textContent).not.toMatch(/excluded/);
  });

  it('renders an older payload without the new keys as before', async () => {
    showHealth(googleHealth());
    const { container } = render(<IngestionHealth />);
    await screen.findByText('storm.duncan@bank.example');
    expect(container.textContent ?? '').not.toMatch(/excluded by policy|Exclusion policy/);
  });

  it('shows no subject, address, rule or thread id for an excluded item: only what the payload carries', async () => {
    const payload = withPolicy(
      { itemsExcluded: 1, itemsSkipped: 1 },
      { itemsExcluded: 1, itemsSkipped: 1, ...({ exclusionRule: 'privileged-label', providerThreadId: 'thread-1', subject: 'Falcon NDA' } as object) },
      1,
    );
    showHealth(payload);
    const { container } = render(<IngestionHealth />);
    await screen.findByText('Exclusion policy v1');
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/falcon|privileged-label|thread-1/i);
    expect(text).not.toContain('—');
  });

  it('words the labels in sentence case, without em dashes', () => {
    expect(excludedLabel(0)).toBeNull();
    expect(excludedLabel(undefined)).toBeNull();
    expect(excludedLabel(1)).toBe('1 excluded by policy');
    expect(policyVersionLabel(null)).toBeNull();
    expect(policyVersionLabel(undefined)).toBeNull();
    expect(policyVersionLabel(0)).toBeNull();
    expect(policyVersionLabel(4)).toBe('Exclusion policy v4');
    expect(countsLabel({ itemsLedgered: 9, itemsRouted: 1, itemsSkipped: 4, itemsExcluded: 4 })).toBe('9 read, 1 routed, 4 excluded by policy');
    for (const text of [excludedLabel(3), policyVersionLabel(3)]) expect(text).not.toContain('—');
  });
});

describe('Google health labels', () => {
  it('maps the delegation status and the group drift to a badge', () => {
    expect(delegationBadge('ok')).toEqual({ label: 'Access approved by your admin', tone: 'positive' });
    expect(delegationBadge('missing')).toEqual({ label: 'Access not approved by your admin', tone: 'negative' });
    expect(delegationBadge('error')).toEqual({ label: 'Approval check failed', tone: 'hold' });
    expect(delegationBadge(null)).toEqual({ label: 'Not checked yet', tone: 'neutral' });
    expect(groupBadge({ status: 'in_sync' }).label).toBe('Group in sync');
    expect(groupBadge({ status: 'drift' }).label).toBe('Group drift');
    expect(groupBadge({ status: 'unavailable' }).label).toBe('Group unreadable');
    expect(groupBadge(undefined).label).toBe('Group not checked yet');
  });

  it('maps the guard reason and the provider to words', () => {
    expect(waitingLabel('no_consent')).toBe("Waiting for the user's consent");
    expect(waitingLabel('not_in_provider_group')).toBe('Not matched to one member of the group');
    expect(waitingLabel('mirror_unavailable')).toBe('Group unreadable');
    expect(waitingLabel('registration_inactive')).toBe('Mail reading is not set up for this provider');
    expect(waitingLabel('site_registrant_lost')).toBe('The admin who registered the site no longer has access');
    expect(sourceLabel({ kind: 'mailbox', provider: 'google' })).toBe('Gmail mailbox');
    expect(sourceLabel({ kind: 'mailbox', provider: 'microsoft' })).toBe('Microsoft 365 mailbox');
    expect(sourceLabel({ kind: 'sharepoint_site', provider: 'microsoft' })).toBe('SharePoint site');
  });

  it('words every reason the guard can give, and an unknown or empty one gracefully', () => {
    // The whole vocabulary (mailbox, group and site reasons, site_registrant_lost included): none falls to the fallback.
    for (const reason of SOURCE_REFUSAL_REASONS) {
      const text = waitingLabel(reason);
      expect(text, reason).not.toBe('Held until access is confirmed');
      expect(text, reason).not.toMatch(/_/);
      expect(text, reason).not.toContain('—');
    }
    // A reason from a newer database, or an archived or empty one, never shows raw snake case.
    for (const reason of ['some_future_reason', 'archived', '']) {
      expect(waitingLabel(reason)).toBe('Held until access is confirmed');
    }
  });

  it('ages a checkpoint in the coarsest unit that keeps it exact enough to judge', () => {
    expect(ageLabel(30)).toBe('just now');
    expect(ageLabel(90)).toBe('1 min ago');
    expect(ageLabel(2 * 3_600)).toBe('2 h ago');
    expect(ageLabel(3 * 86_400)).toBe('3 d ago');
  });

  it('keeps the new visible copy free of em dashes', () => {
    const copy = [
      ...(['ok', 'missing', 'error', null] as const).map((s) => delegationBadge(s).label),
      ...(['in_sync', 'drift', 'unavailable'] as const).map((s) => groupBadge({ status: s }).label),
      waitingLabel('no_consent'),
      waitingLabel('not_in_provider_group'),
      waitingLabel('site_wrong_firm'),
      ageLabel(5_000),
    ];
    for (const text of copy) expect(text).not.toContain('—');
  });
});

describe('labels', () => {
  it('formats times in UTC and says Never for none', () => {
    expect(timeLabel('2026-09-25T23:30:00Z')).toBe('Sep 25, 2026, 11:30 PM UTC');
    expect(timeLabel(null)).toBe('Never');
  });

  it('names the source kind and the counts', () => {
    expect(sourceKindLabel('mailbox')).toBe('Mailbox');
    expect(sourceKindLabel('sharepoint_site')).toBe('SharePoint site');
    expect(countsLabel({ itemsLedgered: 3, itemsRouted: 1, itemsSkipped: 0 })).toBe('3 read, 1 routed');
  });

  it('keeps visible copy free of em dashes', () => {
    for (const text of [timeLabel(null), countsLabel({ itemsLedgered: 3, itemsRouted: 1, itemsSkipped: 2 })]) {
      expect(text).not.toContain('—');
    }
  });
});

describe('IngestionHealth, mail checks (#370)', () => {
  const ENDED: ReaderPassHealth = {
    state: 'ended',
    group: 'completed',
    status: 'complete',
    reason: null,
    startedAt: '2026-10-06T09:00:00.000Z',
    endedAt: '2026-10-06T09:02:00.000Z',
    pages: 2,
    fetched: 34,
    excluded: 3,
    stored: 30,
    checkpointAdvanced: true,
  };
  const TOTALS: ReaderPassTotals = {
    passes: 12,
    completed: 10,
    continued: 1,
    stopped: 0,
    refused: 0,
    failed: 1,
    noEndRecorded: 0,
    fetched: 340,
    excluded: 12,
    stored: 300,
  };

  it('gives each outcome group its label and tone, and the derived states theirs', () => {
    expect(passBadge({ state: 'ended', group: 'completed' })).toEqual({ label: 'Completed', tone: 'positive' });
    expect(passBadge({ state: 'ended', group: 'continued' })).toEqual({ label: 'Continued', tone: 'neutral' });
    expect(passBadge({ state: 'ended', group: 'stopped' })).toEqual({ label: 'Stopped', tone: 'hold' });
    expect(passBadge({ state: 'ended', group: 'refused' })).toEqual({ label: 'Refused', tone: 'hold' });
    expect(passBadge({ state: 'ended', group: 'failed' })).toEqual({ label: 'Failed', tone: 'negative' });
    expect(passBadge({ state: 'in_progress', group: null })).toEqual({ label: 'In progress', tone: 'neutral' });
    expect(passBadge({ state: 'no_end_recorded', group: null })).toEqual({ label: 'No end recorded', tone: 'negative' });
    // A group this build does not know, from a newer database, still reads as ended.
    expect(passBadge({ state: 'ended', group: 'other' as never })).toEqual({ label: 'Ended', tone: 'neutral' });
  });

  it('reads an unfinished pass by the row\'s rule (latestPassLive) when the payload has it', () => {
    // #388's 3600 s in_progress gives way: a crashed worker's pass 20 minutes in is no longer In progress.
    expect(passBadge({ state: 'in_progress', group: null }, false)).toEqual({ label: 'No end recorded', tone: 'negative' });
    // A page still marking progress past the hour is In progress, not No end recorded.
    expect(passBadge({ state: 'no_end_recorded', group: null }, true)).toEqual({ label: 'In progress', tone: 'neutral' });
    // An ended pass keeps its outcome whatever the flag says.
    expect(passBadge({ state: 'ended', group: 'completed' }, false)).toEqual({ label: 'Completed', tone: 'positive' });
  });

  it('shows a crashed worker\'s source as Stale with a pass badge that agrees', async () => {
    const crashed = { ...ENDED, state: 'in_progress' as const, group: null, status: null, reason: null, endedAt: null };
    showHealth(googleHealth({}, { state: 'stale', latestPass: crashed, latestPassLive: false, lastActivityAgeSeconds: 1_200 }));
    render(<IngestionHealth />);
    const row = (await screen.findByText('storm.duncan@bank.example')).closest('li')!;
    expect(within(row).getByText('Stale')).toBeInTheDocument();
    expect(within(row).getByText('No end recorded')).toBeInTheDocument();
    expect(within(row).queryByText('In progress')).not.toBeInTheDocument();
  });

  it('times a pass in UTC, with its end once it has one', () => {
    expect(passTimeLabel(ENDED)).toBe('Started Oct 6, 2026, 9:00 AM UTC, ended Oct 6, 2026, 9:02 AM UTC');
    expect(passTimeLabel({ ...ENDED, state: 'in_progress', endedAt: null })).toBe('Started Oct 6, 2026, 9:00 AM UTC');
    expect(passTimeLabel({ ...ENDED, state: 'no_end_recorded', endedAt: null })).toBe('Started Oct 6, 2026, 9:00 AM UTC');
  });

  it('names the three counts', () => {
    expect(passCountsLabel(ENDED)).toBe('34 fetched, 3 excluded by policy, 30 stored');
  });

  it('sums the last 24 hours, leaving out empty buckets, and says so when there were none', () => {
    expect(passTotalsLabel(TOTALS)).toBe(
      'Last 24 h: 12 mail checks, 10 completed, 1 continued, 1 failed. 340 fetched, 12 excluded by policy, 300 stored.',
    );
    expect(passTotalsLabel({ ...TOTALS, passes: 1, completed: 0, continued: 0, failed: 0, noEndRecorded: 1, fetched: 0, excluded: 0, stored: 0 })).toBe(
      'Last 24 h: 1 mail check, 1 with no end recorded. 0 fetched, 0 excluded by policy, 0 stored.',
    );
    expect(passTotalsLabel({ ...TOTALS, passes: 0 })).toBe('Last 24 h: no mail checks.');
  });

  it('renders the last pass inside its source, and the 24-hour line', async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          health: {
            ...HEALTH,
            sources: [{ ...HEALTH.sources[0], latestPass: ENDED }, { ...HEALTH.sources[1], latestPass: null }],
            totals: { ...HEALTH.totals, passesLast24h: TOTALS },
          },
        }),
        { status: 200 },
      ),
    );
    render(<IngestionHealth />);
    const list = await screen.findByRole('list', { name: 'Content sources' });
    const mail = within(list).getByText('storm.duncan@bank.example').closest('li')!;
    expect(within(mail).getByText('Last mail check')).toBeInTheDocument();
    expect(within(mail).getByText('Completed')).toBeInTheDocument();
    expect(within(mail).getByText('Started Oct 6, 2026, 9:00 AM UTC, ended Oct 6, 2026, 9:02 AM UTC')).toBeInTheDocument();
    expect(within(mail).getByText('34 fetched, 3 excluded by policy, 30 stored')).toBeInTheDocument();
    const site = within(list).getByText('bank.sharepoint.com,site,web').closest('li')!;
    expect(within(site).queryByText('Last mail check')).not.toBeInTheDocument();
    expect(
      screen.getByText('Last 24 h: 12 mail checks, 10 completed, 1 continued, 1 failed. 340 fetched, 12 excluded by policy, 300 stored.'),
    ).toBeInTheDocument();
  });

  it('renders an older payload, without the new keys, exactly as before', async () => {
    stubFetch(new Response(JSON.stringify({ health: HEALTH }), { status: 200 }));
    render(<IngestionHealth />);
    await screen.findByRole('list', { name: 'Content sources' });
    expect(screen.queryByText('Last mail check')).not.toBeInTheDocument();
    expect(screen.queryByText(/Last 24 h/)).not.toBeInTheDocument();
  });

  it('keeps the pass copy free of em dashes', () => {
    for (const text of [
      passBadge({ state: 'no_end_recorded', group: null }).label,
      passTimeLabel(ENDED),
      passCountsLabel(ENDED),
      passTotalsLabel(TOTALS),
      passTotalsLabel({ ...TOTALS, passes: 0 }),
    ]) {
      expect(text).not.toContain('—');
    }
  });
});

describe('IngestionHealth, source states and the reader line (reader liveness)', () => {
  const HALTED = { state: 'halted', lastError: HISTORY_WINDOW_EXCEEDED, lastErrorAt: '2026-10-21T09:10:00Z' } as const;
  const restartLabel = 'Restart reading storm.duncan@bank.example';
  const confirmLabel = 'Confirm restart reading storm.duncan@bank.example';
  /** Restart asks first (it re-reads the whole mailbox): the trigger, then the confirm. */
  async function confirmRestart() {
    fireEvent.click(await screen.findByRole('button', { name: restartLabel }));
    fireEvent.click(await screen.findByRole('button', { name: confirmLabel }));
  }

  it.each([
    ['up_to_date', 'Up to date', 'positive'],
    ['reading', 'Reading', 'neutral'],
    ['not_started', 'Not started', 'neutral'],
    ['stale', 'Stale', 'hold'],
    ['halted', 'Halted', 'negative'],
    ['delegation_broken', 'Access approval broken', 'negative'],
    ['waiting', 'Waiting for access', 'hold'],
    ['failing', 'Failing', 'negative'],
    ['paused', 'Paused', 'hold'],
    ['switched_off', 'Switched off', 'neutral'],
  ] as const)('gives the %s state its label and tone', (state, label, tone) => {
    expect(sourceStateBadge({ state, checkpointState: 'incremental' })).toEqual({ label, tone });
  });

  it('words every state in the vocabulary, with no underscore or em dash', () => {
    for (const state of SOURCE_HEALTH_STATES) {
      const { label } = sourceStateBadge({ state, checkpointState: 'incremental' });
      expect(label, state).not.toMatch(/_/);
      expect(label, state).not.toContain('—');
      // A state this build words is never the checkpoint fallback.
      expect(sourceStateBadge({ state, checkpointState: 'not_started' }), state).toEqual(
        sourceStateBadge({ state, checkpointState: 'backfilling' }),
      );
    }
  });

  it('keeps the checkpoint badge for a payload without a state, or with one from a newer database', () => {
    expect(sourceStateBadge({ checkpointState: 'incremental' })).toEqual({ label: 'Up to date', tone: 'positive' });
    expect(sourceStateBadge({ checkpointState: 'backfilling' })).toEqual({ label: 'Backfilling', tone: 'hold' });
    expect(sourceStateBadge({ state: 'from_the_future' as never, checkpointState: 'not_started' })).toEqual({
      label: 'Not started',
      tone: 'neutral',
    });
  });

  it('gives a reason line to halted, delegation broken and stale, and none to the others', () => {
    expect(sourceStateReason({ state: 'halted' })).toBe(
      'Mail history expired before mail reading caught up. Restarting reads this mailbox again from the start.',
    );
    expect(sourceStateReason({ state: 'delegation_broken' })).toBe(
      "Google refused Conductia's access to this mailbox. A Google Workspace admin restores it, and reading resumes on the next mail check.",
    );
    expect(sourceStateReason({ state: 'stale', lastPassAgeSeconds: 1_260 })).toBe(
      'No completed read and no mail reading progress in the last 15 min; last mail activity 21 min ago.',
    );
    // The activity age (pass row or progress mark, the reader line's clock) wins over the pass age when present.
    expect(sourceStateReason({ state: 'stale', lastPassAgeSeconds: 3_000, lastActivityAgeSeconds: 960 })).toBe(
      'No completed read and no mail reading progress in the last 15 min; last mail activity 16 min ago.',
    );
    expect(sourceStateReason({ state: 'stale', lastPassAgeSeconds: null })).toBe('No mail check recorded for this mailbox.');
    expect(sourceStateReason({ state: 'stale' })).toBe('No mail check recorded for this mailbox.');
    for (const state of SOURCE_HEALTH_STATES.filter((s) => !['halted', 'delegation_broken', 'stale'].includes(s))) {
      expect(sourceStateReason({ state, lastPassAgeSeconds: 10 }), state).toBeNull();
    }
    expect(sourceStateReason({})).toBeNull();
  });

  it('renders the state badge and its reason inside the row', async () => {
    showHealth(googleHealth({}, HALTED));
    render(<IngestionHealth />);
    const row = (await screen.findByText('storm.duncan@bank.example')).closest('li')!;
    expect(within(row).getByText('Halted')).toBeInTheDocument();
    expect(within(row).queryByText('Up to date')).not.toBeInTheDocument();
    expect(within(row).getByText(/Mail history expired before mail reading caught up/)).toBeInTheDocument();
  });

  it('renders the stale reason with the last activity age', async () => {
    showHealth(googleHealth({}, { state: 'stale', lastPassAgeSeconds: 1_260 }));
    render(<IngestionHealth />);
    expect(await screen.findByText(/last mail activity 21 min ago/)).toBeInTheDocument();
  });

  it('words the history_window_exceeded error, and shows any other code verbatim', async () => {
    expect(lastErrorLabel(HISTORY_WINDOW_EXCEEDED)).toBe('Mail history expired');
    expect(lastErrorLabel('Graph 429 TooManyRequests (throttled)')).toBe('Graph 429 TooManyRequests (throttled)');
    showHealth(googleHealth({}, HALTED));
    const first = render(<IngestionHealth />);
    const row = (await screen.findByText('storm.duncan@bank.example')).closest('li')!;
    const lastError = within(row).getByText('Last error').nextElementSibling!;
    expect(lastError).toHaveTextContent('Mail history expired, Oct 21, 2026, 9:10 AM UTC');
    expect(lastError.textContent).not.toMatch(/history_window_exceeded/);
    first.unmount();
    vi.unstubAllGlobals();

    showHealth(googleHealth({}, { lastError: 'some_other_code', lastErrorAt: '2026-10-21T09:10:00Z' }));
    render(<IngestionHealth />);
    expect(await screen.findByText(/some_other_code/)).toBeInTheDocument();
  });

  it('shows the checkpoint label for a payload without a state', async () => {
    showHealth(googleHealth({}, { checkpointState: 'backfilling' }));
    render(<IngestionHealth />);
    const row = (await screen.findByText('storm.duncan@bank.example')).closest('li')!;
    expect(within(row).getByText('Backfilling')).toBeInTheDocument();
  });

  describe('the reader line', () => {
    const reader = (over: Partial<ReaderHealth>): ReaderHealth => ({
      enabled: true,
      lastActiveAt: '2026-10-21T09:10:00Z',
      lastActiveAgeSeconds: 60,
      state: 'reading',
      ...over,
    });

    it('words each state with its tone and detail', () => {
      expect(readerLine(reader({ state: 'reading' }))).toEqual({
        label: 'Reading',
        tone: 'positive',
        detail: 'Last mail check Oct 21, 2026, 9:10 AM UTC',
      });
      expect(readerLine(reader({ state: 'active' }))).toEqual({
        label: 'Running',
        tone: 'neutral',
        detail: 'Last mail check Oct 21, 2026, 9:10 AM UTC. No mailbox is reading right now; see each mailbox below.',
      });
      expect(readerLine(reader({ state: 'not_reading' }))).toEqual({
        label: 'Not reading',
        tone: 'negative',
        detail:
          'No mail check since Oct 21, 2026, 9:10 AM UTC. Mail reading may be stopped, or retrying failing mailboxes with growing delays.',
      });
      expect(readerLine(reader({ state: 'not_reading', lastActiveAt: null, lastActiveAgeSeconds: null }))).toEqual({
        label: 'Not reading',
        tone: 'negative',
        detail: 'No mail check recorded.',
      });
      expect(readerLine(reader({ state: 'switched_off', enabled: false }))).toEqual({
        label: 'Switched off',
        tone: 'neutral',
        detail: 'Reading is switched off.',
      });
      expect(readerLine(reader({ state: 'idle', lastActiveAt: null, lastActiveAgeSeconds: null }))).toBeNull();
    });

    it('has copy for every state but idle, free of underscores and em dashes', () => {
      for (const state of READER_HEALTH_STATES) {
        const line = readerLine(reader({ state }));
        if (state === 'idle') {
          expect(line).toBeNull();
          continue;
        }
        expect(line, state).not.toBeNull();
        for (const text of [line!.label, line!.detail]) {
          expect(text, state).not.toMatch(/_/);
          expect(text, state).not.toContain('—');
        }
      }
    });

    it('renders as a Reader group before the totals, and nothing for idle or a payload without the key', async () => {
      showHealth(googleHealth({ reader: reader({ state: 'not_reading' }) }));
      const first = render(<IngestionHealth />);
      const group = await screen.findByRole('group', { name: 'Mail reading' });
      expect(within(group).getByText('Not reading')).toBeInTheDocument();
      expect(within(group).getByText(/No mail check since Oct 21, 2026, 9:10 AM UTC/)).toBeInTheDocument();
      first.unmount();
      vi.unstubAllGlobals();

      showHealth(googleHealth({ reader: reader({ state: 'idle', lastActiveAt: null, lastActiveAgeSeconds: null }) }));
      const second = render(<IngestionHealth />);
      await screen.findByText('storm.duncan@bank.example');
      expect(screen.queryByRole('group', { name: 'Mail reading' })).not.toBeInTheDocument();
      second.unmount();
      vi.unstubAllGlobals();

      showHealth(googleHealth({ reader: null }));
      const third = render(<IngestionHealth />);
      await screen.findByText('storm.duncan@bank.example');
      expect(screen.queryByRole('group', { name: 'Mail reading' })).not.toBeInTheDocument();
      third.unmount();
      vi.unstubAllGlobals();

      showHealth(googleHealth());
      render(<IngestionHealth />);
      await screen.findByText('storm.duncan@bank.example');
      expect(screen.queryByRole('group', { name: 'Mail reading' })).not.toBeInTheDocument();
    });
  });

  describe('Restart reading', () => {
    it('is shown to the firm admin on a halted source', async () => {
      showHealth(googleHealth({}, HALTED));
      render(<IngestionHealth />);
      expect(await screen.findByRole('button', { name: restartLabel })).toHaveTextContent('Restart reading');
    });

    it('is shown on a paused and halted source, which stays pausable to resume, and on a Microsoft one', async () => {
      showHealth(googleHealth({}, { ...HALTED, status: 'paused' }));
      const first = render(<IngestionHealth />);
      expect(await screen.findByRole('button', { name: restartLabel })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Resume reading storm.duncan@bank.example' })).toBeInTheDocument();
      first.unmount();
      vi.unstubAllGlobals();

      showHealth(googleHealth({}, { ...HALTED, provider: 'microsoft' }));
      render(<IngestionHealth />);
      expect(await screen.findByRole('button', { name: restartLabel })).toBeInTheDocument();
      // The pause route serves Gmail only: a Microsoft source gets Restart alone.
      expect(screen.queryByRole('button', { name: /Pause reading/ })).not.toBeInTheDocument();
    });

    it('is not shown to the control room, on an archived source, or on any other source', async () => {
      showHealth(googleHealth({ viewerCanManageSources: false }, HALTED));
      const cco = render(<IngestionHealth />);
      await screen.findByText('storm.duncan@bank.example');
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      cco.unmount();
      vi.unstubAllGlobals();

      showHealth(googleHealth({}, { ...HALTED, archived: true, status: 'paused' }));
      const archived = render(<IngestionHealth />);
      await screen.findByText('storm.duncan@bank.example');
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      archived.unmount();
      vi.unstubAllGlobals();

      showHealth(googleHealth({}, { lastError: 'Graph 429 TooManyRequests (throttled)', state: 'failing' }));
      const other = render(<IngestionHealth />);
      await screen.findByText('storm.duncan@bank.example');
      expect(screen.queryByRole('button', { name: /Restart reading/ })).not.toBeInTheDocument();
      other.unmount();
      vi.unstubAllGlobals();

      showHealth(googleHealth({}, { state: 'stale' }));
      render(<IngestionHealth />);
      await screen.findByText('storm.duncan@bank.example');
      expect(screen.queryByRole('button', { name: /Restart reading/ })).not.toBeInTheDocument();
    });

    it('posts to the restart route, then the refetched payload reads Not started with no button', async () => {
      const fetchMock = sequenceFetch(
        healthReply(googleHealth({}, HALTED)),
        jsonReply({ id: 's-gmail', restarted: true }),
        healthReply(
          googleHealth({}, { state: 'not_started', checkpointState: 'not_started', lastError: null, lastErrorAt: null, checkpointAgeSeconds: null }),
        ),
      );
      render(<IngestionHealth />);
      await confirmRestart();

      expect(await screen.findByText('Not started')).toBeInTheDocument();
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
      expect(post[0]).toBe('/api/v1/discovery/sources/s-gmail/restart');
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        '/api/v1/discovery/health',
        '/api/v1/discovery/sources/s-gmail/restart',
        '/api/v1/discovery/health',
      ]);
      const row = screen.getByText('storm.duncan@bank.example').closest('li')!;
      expect(within(row).queryByText('Halted')).not.toBeInTheDocument();
      expect(within(row).queryByText(/Mail history expired/)).not.toBeInTheDocument();
      expect(within(row).queryByRole('button', { name: /Restart reading/ })).not.toBeInTheDocument();
    });

    it('says so when the refetch after a successful restart fails, keeping the card it had', async () => {
      sequenceFetch(healthReply(googleHealth({}, HALTED)), jsonReply({ id: 's-gmail', restarted: true }), jsonReply({ error: 'x' }, 500));
      render(<IngestionHealth />);
      await confirmRestart();
      expect(await screen.findByText('Could not refresh, retrying.')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByText('Halted')).toBeInTheDocument();
    });

    it('words a refused restart (404, for any refusal) neutrally, keeps the row and does not refetch', async () => {
      const fetchMock = sequenceFetch(healthReply(googleHealth({}, HALTED)), jsonReply({ error: 'Not found' }, 404));
      render(<IngestionHealth />);
      await confirmRestart();
      // The route answers 404 for every refusal, so the card names none of them (not the cooldown, not a retry time).
      expect(await screen.findByRole('alert')).toHaveTextContent(/^Restart is not available right now\.$/);
      expect(screen.queryByText(/Try again shortly|once a day/)).not.toBeInTheDocument();
      expect(screen.getByText('Halted')).toBeInTheDocument();
      // The confirmation stays open, so the admin can try again or cancel.
      await waitFor(() => expect(screen.getByRole('button', { name: confirmLabel })).toBeEnabled());
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('asks to try again shortly when the restart fails for another reason (a 500)', async () => {
      const fetchMock = sequenceFetch(healthReply(googleHealth({}, HALTED)), jsonReply({ error: 'Could not restart the source' }, 500));
      render(<IngestionHealth />);
      await confirmRestart();
      expect(await screen.findByRole('alert')).toHaveTextContent('The restart could not be saved. Try again shortly.');
      expect(screen.queryByText(/not available right now/)).not.toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('asks first: the consequence, then Cancel sends nothing and brings the button back', async () => {
      const fetchMock = sequenceFetch(healthReply(googleHealth({}, HALTED)));
      render(<IngestionHealth />);
      fireEvent.click(await screen.findByRole('button', { name: restartLabel }));
      const confirm = screen.getByRole('group', { name: 'Confirm restart for storm.duncan@bank.example' });
      expect(within(confirm).getByText('Restarting reads this mailbox again from the start.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: restartLabel })).not.toBeInTheDocument();

      fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel restart for storm.duncan@bank.example' }));
      expect(await screen.findByRole('button', { name: restartLabel })).toBeEnabled();
      expect(screen.queryByRole('button', { name: confirmLabel })).not.toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('sends one POST however often the confirm is clicked', async () => {
      let release!: (value: Response) => void;
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return new Promise<Response>((r) => (release = r));
        void url;
        return Promise.resolve(healthReply(googleHealth({}, HALTED))());
      });
      vi.stubGlobal('fetch', fetchMock);
      render(<IngestionHealth />);
      fireEvent.click(await screen.findByRole('button', { name: restartLabel }));
      const confirm = screen.getByRole('button', { name: confirmLabel });
      fireEvent.click(confirm);
      fireEvent.click(confirm);
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
      release(new Response(JSON.stringify({ id: 's-gmail', restarted: true }), { status: 200 }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    });
  });

  it('keeps the new visible copy free of em dashes and underscores', () => {
    const copy = [
      ...SOURCE_HEALTH_STATES.flatMap((state) => [
        sourceStateBadge({ state, checkpointState: 'incremental' }).label,
        sourceStateReason({ state, lastPassAgeSeconds: 1_260 }) ?? '',
        sourceStateReason({ state, lastPassAgeSeconds: null }) ?? '',
      ]),
      lastErrorLabel(HISTORY_WINDOW_EXCEEDED),
    ];
    for (const text of copy) {
      expect(text).not.toContain('—');
      expect(text).not.toMatch(/_/);
    }
  });
});

// S1 (#409 stack audit, round-3 amendment): an open card reads the health again on its own, so a worker that stops
// while the page is open does not keep a healthy card.
describe('IngestionHealth, refetching while open', () => {
  const START = Date.parse('2026-10-21T09:00:00Z');
  let hidden = false;
  const reading = googleHealth({ reader: { enabled: true, lastActiveAt: '2026-10-21T08:59:00Z', lastActiveAgeSeconds: 60, state: 'reading' } });
  const stopped = googleHealth({ reader: { enabled: true, lastActiveAt: '2026-10-21T08:59:00Z', lastActiveAgeSeconds: 960, state: 'not_reading' } });
  const updatedLine = () => screen.getByText((_, el) => el?.tagName === 'P' && (el.textContent ?? '').startsWith('Updated '));

  function setup(...replies: Array<() => Response>) {
    // Only the interval and the clock are faked, so React and waitFor keep their real timeouts.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(START);
    hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    return sequenceFetch(...replies);
  }
  afterEach(() => {
    vi.useRealTimers();
    delete (document as { hidden?: boolean }).hidden;
  });

  it('labels the last read by its age', () => {
    expect(HEALTH_REFRESH_MS).toBe(60_000);
    expect(updatedLabel(START, START + 30_000)).toBe('Updated just now');
    expect(updatedLabel(START, START + 180_000)).toBe('Updated 3 min ago');
    expect(updatedLabel(START + 5_000, START)).toBe('Updated just now');
  });

  it('reads again every minute while visible, and the new payload drives the card', async () => {
    const fetchMock = setup(healthReply(reading), healthReply(stopped));
    render(<IngestionHealth />);
    expect(await screen.findByText('Reading')).toBeInTheDocument();
    expect(updatedLine()).toHaveTextContent('Updated just now.');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(HEALTH_REFRESH_MS));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Not reading')).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/v1/discovery/health', '/api/v1/discovery/health']);
  });

  it('does not read while the page is hidden, and reads once when it comes back', async () => {
    const fetchMock = setup(healthReply(reading), healthReply(stopped));
    render(<IngestionHealth />);
    await screen.findByText('Reading');

    hidden = true;
    act(() => vi.advanceTimersByTime(3 * HEALTH_REFRESH_MS));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    hidden = false;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Not reading')).toBeInTheDocument();
    await waitFor(() => expect(updatedLine()).toHaveTextContent('Updated just now.'));
  });

  it('reads on focus too', async () => {
    const fetchMock = setup(healthReply(reading), healthReply(stopped));
    render(<IngestionHealth />);
    await screen.findByText('Reading');
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('keeps the card when a timed read fails, ages the Updated line and says it is retrying', async () => {
    const fetchMock = setup(healthReply(reading), jsonReply({ error: 'x' }, 500));
    render(<IngestionHealth />);
    await screen.findByText('Reading');
    expect(screen.queryByText('Could not refresh, retrying.')).not.toBeInTheDocument();

    // One minute at a time: a tick while a read is still running reads nothing more.
    for (let minute = 1; minute <= 3; minute += 1) {
      act(() => vi.advanceTimersByTime(HEALTH_REFRESH_MS));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1 + minute));
      expect(await screen.findByText('Could not refresh, retrying.')).toBeInTheDocument();
    }
    expect(updatedLine()).toHaveTextContent('Updated 3 min ago. Could not refresh, retrying.');
    expect(screen.getByText('Reading')).toBeInTheDocument();
  });

  it('polls nothing for a viewer the route hides the card from', async () => {
    const fetchMock = setup(jsonReply({ error: 'Not found' }, 404));
    const { container } = render(<IngestionHealth />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    // Let the effects of that render run (the timer is cleared there) before the clock moves.
    await act(async () => {});
    act(() => vi.advanceTimersByTime(3 * HEALTH_REFRESH_MS));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// #353: each Gmail mailbox shows how far back its first read goes, to the admin and the CCO alike; a Microsoft source
// shows none (its reader does not honour the window yet), and Restart names the date it reads from.
describe('IngestionHealth, ingestion window (#353)', () => {
  const GMAIL = { kind: 'mailbox', provider: 'google' } as const;
  const HALTED = { state: 'halted', lastError: HISTORY_WINDOW_EXCEEDED, lastErrorAt: '2026-10-21T09:10:00Z' } as const;

  it('formats the window as a UTC calendar date, whatever the browser time zone', () => {
    expect(dateLabel('2026-07-17')).toBe('Jul 17, 2026');
    const tz = process.env.TZ;
    try {
      for (const zone of ['America/Los_Angeles', 'Pacific/Kiritimati']) {
        process.env.TZ = zone;
        expect(dateLabel('2026-01-01'), zone).toBe('Jan 1, 2026');
        expect(dateLabel('2026-07-17'), zone).toBe('Jul 17, 2026');
      }
    } finally {
      process.env.TZ = tz;
    }
    for (const bad of [null, undefined, '', '17/07/2026', '2026-07-17T00:00:00Z', 'not a date']) expect(dateLabel(bad), String(bad)).toBeNull();
  });

  it('labels a Gmail mailbox by its window, or as the whole mailbox, and nothing else', () => {
    expect(windowLabel({ ...GMAIL, backfillSince: '2026-07-17' })).toBe('Reads mail from Jul 17, 2026');
    expect(windowLabel({ ...GMAIL, backfillSince: null })).toBe('Whole mailbox');
    // An older payload without the key, a Microsoft mailbox and a site get no line.
    expect(windowLabel({ ...GMAIL })).toBeNull();
    expect(windowLabel({ kind: 'mailbox', provider: 'microsoft', backfillSince: '2026-07-17' })).toBeNull();
    expect(windowLabel({ kind: 'sharepoint_site', provider: 'microsoft', backfillSince: null })).toBeNull();
    expect(windowLabel({ ...GMAIL, backfillSince: 'garbage' })).toBeNull();
  });

  it('says what a restart reads again: from the window, else from the start', () => {
    expect(restartScopeLabel({ ...GMAIL, backfillSince: '2026-07-17' })).toBe('Restarting reads this mailbox again from Jul 17, 2026.');
    expect(restartScopeLabel({ ...GMAIL, backfillSince: null })).toBe('Restarting reads this mailbox again from the start.');
    expect(restartScopeLabel({ ...GMAIL })).toBe('Restarting reads this mailbox again from the start.');
    expect(restartScopeLabel({ kind: 'mailbox', provider: 'microsoft', backfillSince: '2026-07-17' })).toBe(
      'Restarting reads this mailbox again from the start.',
    );
    expect(sourceStateReason({ state: 'halted', ...GMAIL, backfillSince: '2026-07-17' })).toBe(
      'Mail history expired before mail reading caught up. Restarting reads this mailbox again from Jul 17, 2026.',
    );
  });

  it('shows the Window line in the Gmail row, to the firm admin and to the control room', async () => {
    for (const viewerCanManageSources of [true, false]) {
      showHealth(googleHealth({ viewerCanManageSources }, { backfillSince: '2026-07-17', windowLocked: false }));
      const view = render(<IngestionHealth />);
      const row = (await screen.findByText('storm.duncan@bank.example')).closest('li')!;
      const term = within(row).getByText('Window');
      expect(term.tagName).toBe('DT');
      expect(term.nextElementSibling).toHaveTextContent(/^Reads mail from Jul 17, 2026$/);
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it('shows Whole mailbox for a Gmail source with no window', async () => {
    showHealth(googleHealth({}, { backfillSince: null, windowLocked: true }));
    render(<IngestionHealth />);
    const row = (await screen.findByText('storm.duncan@bank.example')).closest('li')!;
    expect(within(row).getByText('Window').nextElementSibling).toHaveTextContent(/^Whole mailbox$/);
  });

  it('shows no Window line on a Microsoft mailbox or a site, or for an older payload', async () => {
    const microsoft = HEALTH.sources.map((s) => ({ ...s, backfillSince: '2026-07-17' }));
    showHealth({ ...HEALTH, viewerCanManageSources: true, sources: microsoft });
    const first = render(<IngestionHealth />);
    await screen.findByText('storm.duncan@bank.example');
    expect(screen.queryByText('Window')).not.toBeInTheDocument();
    expect(screen.queryByText(/Reads mail from/)).not.toBeInTheDocument();
    first.unmount();
    vi.unstubAllGlobals();

    showHealth(googleHealth());
    render(<IngestionHealth />);
    await screen.findByText('storm.duncan@bank.example');
    expect(screen.queryByText('Window')).not.toBeInTheDocument();
    expect(screen.queryByText('Whole mailbox')).not.toBeInTheDocument();
  });

  it('names the window date in the halted reason and the restart confirmation', async () => {
    showHealth(googleHealth({}, { ...HALTED, backfillSince: '2026-07-17', windowLocked: true }));
    render(<IngestionHealth />);
    expect(
      await screen.findByText('Mail history expired before mail reading caught up. Restarting reads this mailbox again from Jul 17, 2026.'),
    ).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Restart reading storm.duncan@bank.example' }));
    const confirm = screen.getByRole('group', { name: 'Confirm restart for storm.duncan@bank.example' });
    expect(within(confirm).getByText('Restarting reads this mailbox again from Jul 17, 2026.')).toBeInTheDocument();
  });

  it('keeps the window copy free of em dashes and underscores', () => {
    const copy = [
      windowLabel({ ...GMAIL, backfillSince: '2026-07-17' }),
      windowLabel({ ...GMAIL, backfillSince: null }),
      restartScopeLabel({ ...GMAIL, backfillSince: '2026-07-17' }),
      restartScopeLabel({ ...GMAIL, backfillSince: null }),
    ];
    for (const text of copy) {
      expect(text).not.toBeNull();
      expect(text).not.toContain('—');
      expect(text).not.toMatch(/_/);
    }
  });
});

// #353 slice 3: before a Gmail mailbox's first read the firm admin can move its window, within the last 730 days (UTC),
// and the card gates the control on the server's windowLocked (the RPC's own refusal), never on checkpointState.
describe('IngestionHealth, setting the window (#353)', () => {
  const NOW = Date.parse('2026-10-16T23:30:00Z');
  const OPEN = { backfillSince: '2026-07-18', windowLocked: false, state: 'not_started', checkpointState: 'not_started' } as const;
  const changeLabel = 'Change window for storm.duncan@bank.example';
  const saveLabel = 'Save window for storm.duncan@bank.example';

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function openEditor() {
    fireEvent.click(await screen.findByRole('button', { name: changeLabel }));
    return screen.getByRole('group', { name: 'Set window for storm.duncan@bank.example' });
  }

  it('bounds the window by the UTC date, whatever the browser time zone', () => {
    const tz = process.env.TZ;
    try {
      for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
        process.env.TZ = zone;
        expect(utcDateIso(NOW), zone).toBe('2026-10-16');
        expect(windowBounds(NOW), zone).toEqual({ min: '2024-10-16', max: '2026-10-16', defaultSince: '2026-07-18' });
      }
    } finally {
      process.env.TZ = tz;
    }
    expect(utcDateIso(Date.parse('2026-03-01T00:00:00Z'), 1)).toBe('2026-02-28');
  });

  it('offers Change window to the firm admin only while the server says the window is open', async () => {
    showHealth(googleHealth({}, OPEN));
    const open = render(<IngestionHealth />);
    expect(await screen.findByRole('button', { name: changeLabel })).toHaveTextContent('Change window');
    open.unmount();
    vi.unstubAllGlobals();

    // A reset source reads Not started but has a started backfill: the RPC refuses it, so the card offers nothing.
    for (const source of [
      { ...OPEN, windowLocked: true },
      { ...OPEN, windowLocked: undefined },
      { ...OPEN, archived: true, status: 'paused' as const },
      { ...OPEN, provider: 'microsoft' as const },
    ]) {
      showHealth(googleHealth({}, source));
      const view = render(<IngestionHealth />);
      await screen.findByText('storm.duncan@bank.example');
      expect(screen.queryByRole('button', { name: changeLabel }), JSON.stringify(source)).not.toBeInTheDocument();
      view.unmount();
      vi.unstubAllGlobals();
    }

    showHealth(googleHealth({ viewerCanManageSources: false }, OPEN));
    render(<IngestionHealth />);
    await screen.findByText('storm.duncan@bank.example');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Reads mail from Jul 18, 2026')).toBeInTheDocument();
  });

  it('offers it on a paused source too, so a halted long read can be paused, restarted, shortened and resumed', async () => {
    showHealth(googleHealth({}, { ...OPEN, status: 'paused', state: 'paused' }));
    render(<IngestionHealth />);
    expect(await screen.findByRole('button', { name: changeLabel })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume reading storm.duncan@bank.example' })).toBeInTheDocument();
  });

  it('opens a date field on the current window, bounded to today and 730 days back in UTC', async () => {
    showHealth(googleHealth({}, OPEN));
    render(<IngestionHealth />);
    const editor = await openEditor();
    const input = within(editor).getByLabelText('Read mail from') as HTMLInputElement;
    expect(input.type).toBe('date');
    expect(input.value).toBe('2026-07-18');
    expect(input.min).toBe('2024-10-16');
    expect(input.max).toBe('2026-10-16');
    expect(screen.queryByRole('button', { name: changeLabel })).not.toBeInTheDocument();
  });

  it('starts a source with no window on the default', async () => {
    showHealth(googleHealth({}, { ...OPEN, backfillSince: null }));
    render(<IngestionHealth />);
    const editor = await openEditor();
    expect((within(editor).getByLabelText('Read mail from') as HTMLInputElement).value).toBe('2026-07-18');
  });

  it('warns about a longer first read only for a date before the default', async () => {
    showHealth(googleHealth({}, OPEN));
    render(<IngestionHealth />);
    const editor = await openEditor();
    const input = within(editor).getByLabelText('Read mail from');
    expect(within(editor).queryByText(WINDOW_LONG_HINT)).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '2026-09-01' } });
    expect(within(editor).queryByText(WINDOW_LONG_HINT)).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '2025-01-01' } });
    expect(within(editor).getByText(WINDOW_LONG_HINT)).toBeInTheDocument();
  });

  it('saves with one PUT, then the refetched payload drives the line', async () => {
    const fetchMock = sequenceFetch(
      healthReply(googleHealth({}, OPEN)),
      jsonReply({ id: 's-gmail', backfillSince: '2025-01-01', changed: true }),
      healthReply(googleHealth({}, { ...OPEN, backfillSince: '2025-01-01' })),
    );
    render(<IngestionHealth />);
    const editor = await openEditor();
    fireEvent.change(within(editor).getByLabelText('Read mail from'), { target: { value: '2025-01-01' } });
    fireEvent.click(within(editor).getByRole('button', { name: saveLabel }));

    expect(await screen.findByText('Reads mail from Jan 1, 2025')).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/discovery/health',
      '/api/v1/discovery/sources/s-gmail/window',
      '/api/v1/discovery/health',
    ]);
    const put = fetchMock.mock.calls[1]![1]!;
    expect(put.method).toBe('PUT');
    expect(JSON.parse(String(put.body))).toEqual({ since: '2025-01-01' });
    expect(screen.queryByRole('group', { name: 'Set window for storm.duncan@bank.example' })).not.toBeInTheDocument();
  });

  it.each([
    [409, { error: 'window_locked' }, 'Reading has started. The window is fixed for this pass.'],
    [400, { error: 'out_of_range' }, 'Choose a date within the last two years.'],
    [404, { error: 'Not found' }, 'Changing the window is not available right now.'],
    [500, { error: 'Could not set the window' }, 'The window could not be saved. Try again shortly.'],
  ])('words a %i and keeps the editor open, without refetching', async (status, body, copy) => {
    const fetchMock = sequenceFetch(healthReply(googleHealth({}, OPEN)), jsonReply(body, status));
    render(<IngestionHealth />);
    const editor = await openEditor();
    fireEvent.click(within(editor).getByRole('button', { name: saveLabel }));
    expect(await within(editor).findByRole('alert')).toHaveTextContent(new RegExp(`^${copy.replace(/\./g, '\\.')}$`));
    await waitFor(() => expect(within(editor).getByRole('button', { name: saveLabel })).toBeEnabled());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('Cancel sends nothing and brings the button back', async () => {
    const fetchMock = sequenceFetch(healthReply(googleHealth({}, OPEN)));
    render(<IngestionHealth />);
    const editor = await openEditor();
    fireEvent.click(within(editor).getByRole('button', { name: 'Cancel window change for storm.duncan@bank.example' }));
    expect(await screen.findByRole('button', { name: changeLabel })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends one PUT however often Save is clicked', async () => {
    let release!: (value: Response) => void;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      void url;
      if (init?.method === 'PUT') return new Promise<Response>((r) => (release = r));
      return Promise.resolve(healthReply(googleHealth({}, OPEN))());
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<IngestionHealth />);
    const editor = await openEditor();
    const save = within(editor).getByRole('button', { name: saveLabel });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
    release(new Response(JSON.stringify({ id: 's-gmail', backfillSince: '2026-07-18', changed: false }), { status: 200 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it('names the worker\'s halt rule in the long-window hint, not a Gmail retention period (audit r1 item 4)', () => {
    expect(WINDOW_LONG_HINT).toBe('A longer window makes the first read longer. A first read that takes more than 5 days can halt.');
    expect(WINDOW_LONG_HINT).toContain(`${HISTORY_WINDOW_HALT_DAYS} days`);
    expect(WINDOW_LONG_HINT).not.toMatch(/history is kept/);
  });

  it('keeps the window control copy free of em dashes and underscores', () => {
    for (const text of [WINDOW_LONG_HINT, ...Object.values(WINDOW_FAILURE)]) {
      expect(text).not.toContain('—');
      expect(text).not.toMatch(/_/);
    }
  });
});
