import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import * as React from 'react';

import { AuditTrail } from '../src/components/audit/AuditTrail';
import { eventBelongsToDeal, logAudit, clearAudit } from '../src/lib/audit/store';
import { fetchServerAudit } from '@/lib/audit/serverAudit';
import type { FixtureDeal } from '../src/lib/rail/deals';

const { useParamsMock, apiCreateEnabled, liveDeals, userReady } = vi.hoisted(() => ({
  useParamsMock: { projectId: 'project-summit' },
  apiCreateEnabled: { current: false },
  liveDeals: { current: null as FixtureDeal[] | null },
  userReady: { current: true },
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: useParamsMock.projectId }),
}));

// The signed-in person: their own server rows read "You".
vi.mock('@/lib/auth/useCurrentUser', () => ({
  useCurrentUser: () => ({
    state: userReady.current
      ? { status: 'ready', data: { user: { id: 'me-1' } } }
      : { status: 'loading', email: null },
  }),
}));

// [] = the deal's platform trail is empty; 'not-on-deal' = the route refused it; null = the read failed.
vi.mock('@/lib/audit/serverAudit', () => ({
  fetchServerAudit: vi.fn(async () => []),
}));

vi.mock('@/lib/flags/FlagsContext', () => ({
  useFlag: (key: string) => key === 'gate0_api_create' && apiCreateEnabled.current,
}));

vi.mock('@/lib/deals/useDeals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/deals/useDeals')>();
  return {
    ...actual,
    // Same-module: useActiveDealState closes over the real useDeals, so
    // override the hook AuditTrail calls when a test injects a live deal list.
    useActiveDealState: (segment: string) => {
      if (liveDeals.current) {
        return {
          deal:
            actual.resolveActiveDeal(
              segment,
              liveDeals.current,
              actual.dealListSource(apiCreateEnabled.current, false),
            ) ?? actual.pendingDealForCode(segment),
          unavailable: false,
          retry: () => {},
        };
      }
      return actual.useActiveDealState(segment);
    },
  };
});

/*
 * Audit Trail — the compliance record made visible.
 *
 * Contracts under test:
 *   1. The screen renders the persisted log seeded before mount (newest-first),
 *      each event carrying its kind chip, action, target, and deal.
 *   2. The kind filter narrows the register (Steps / Documents umbrella).
 *   3. It is live: an event logged AFTER mount appears without a re-render.
 *   4. The empty state reads honestly when nothing has been logged.
 *   5. A created (API) deal never inherits another deal's local events —
 *      including unstamped ones and events wrongly falling back to Summit.
 */

beforeEach(() => {
  clearAudit();
  useParamsMock.projectId = 'project-summit';
  apiCreateEnabled.current = false;
  liveDeals.current = null;
  userReady.current = true;
  vi.mocked(fetchServerAudit).mockReset();
  vi.mocked(fetchServerAudit).mockImplementation(async () => []);
  // The AI spend panel's own read: a deal with no AI calls yet (its failed
  // read is a state of its own, tested in ai-spend-panel.test.tsx).
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        summary: { totalCostUsd: 0, calls: 0, unpricedCalls: 0, byDeal: [], byPerson: [], byTask: [], byModel: [] },
      }),
    })),
  );
});

afterEach(() => {
  cleanup();
  clearAudit();
  vi.unstubAllGlobals();
});

describe('eventBelongsToDeal', () => {
  const deal = { id: 'FALCO-2026-041', code: 'FALCO-2026-041', codename: 'Project Falco' };

  it('matches by codename, code, or id — never an unstamped or foreign event', () => {
    expect(eventBelongsToDeal({ deal: 'Project Falco' }, deal)).toBe(true);
    expect(eventBelongsToDeal({ deal: 'FALCO-2026-041' }, deal)).toBe(true);
    expect(eventBelongsToDeal({ deal: 'Project Summit' }, deal)).toBe(false);
    expect(eventBelongsToDeal({ deal: undefined }, deal)).toBe(false);
  });
});

describe('AuditTrail — register render', () => {
  it('renders the log scoped to the active deal, excluding other deals and unstamped events', async () => {
    logAudit('chat', 'Asked', 'What is the valuation range?', {
      deal: 'Project Summit',
    });
    logAudit('step', 'Ran skill', 'Teaser Draft', { deal: 'Project Atlas' });
    logAudit('skill', 'Opened', 'Financial Performance');

    render(<AuditTrail />);

    expect(
      screen.getByRole('heading', { name: 'Audit Trail' }),
    ).toBeInTheDocument();

    expect(
      screen.getByText('What is the valuation range?'),
    ).toBeInTheDocument();
    expect(screen.getByText('Chat')).toBeInTheDocument();

    // COMPLIANCE: another deal's action must NOT appear on this deal's record.
    expect(screen.queryByText('Teaser Draft')).toBeNull();
    expect(screen.queryByText('Project Atlas')).toBeNull();
    // Unstamped events leak across deals (one shared localStorage key).
    expect(screen.queryByText('Financial Performance')).toBeNull();

    expect(await screen.findByText('1 event')).toBeInTheDocument();
  });

  it('shows the per-row deal chip only on the cross-deal view', async () => {
    logAudit('chat', 'Asked', 'Scoped question', { deal: 'Project Summit' });
    const { unmount } = render(<AuditTrail />);
    await screen.findByText('Scoped question');
    expect(screen.queryByTestId('audit-row-deal')).toBeNull();
    unmount();
    useParamsMock.projectId = '';
    render(<AuditTrail />);
    await screen.findByText('Scoped question');
    expect(screen.getByTestId('audit-row-deal')).toHaveTextContent('Project Summit');
  });

  it('does not show another deal when the URL is an API-created deal code', async () => {
    useParamsMock.projectId = 'FALCO-2026-041';
    apiCreateEnabled.current = true;
    liveDeals.current = [
      {
        id: 'FALCO-2026-041',
        code: 'FALCO-2026-041',
        codename: 'Project Falco',
        target: '',
        sector: '',
        status: 'Intake',
        cursorStepId: 'p1-s1',
        entryStepSeq: 1,
        gate0Complete: true,
        dealRole: 'Managing Director',
      },
    ];

    logAudit('chat', 'Asked', 'Summit-only question', { deal: 'Project Summit' });
    logAudit('skill', 'Opened', 'Unstamped skill');
    logAudit('platform', 'Recorded conflicts approval', 'Approved by Avery', {
      deal: 'Project Falco',
    });

    render(<AuditTrail />);

    expect(screen.getByText('Approved by Avery')).toBeInTheDocument();
    expect(screen.queryByText('Summit-only question')).toBeNull();
    expect(screen.queryByText('Unstamped skill')).toBeNull();
    expect(await screen.findByText('1 event')).toBeInTheDocument();
  });
});

describe('AuditTrail — filter', () => {
  it('narrows to Steps only', async () => {
    logAudit('chat', 'Asked', 'What is the valuation range?', {
      deal: 'Project Summit',
    });
    logAudit('step', 'Marked complete', 'Exit Readiness', {
      deal: 'Project Summit',
    });
    logAudit('skill', 'Opened', 'Financial Performance', {
      deal: 'Project Summit',
    });

    render(<AuditTrail />);

    fireEvent.click(screen.getByRole('button', { name: 'Steps' }));

    expect(screen.getByText('Exit Readiness')).toBeInTheDocument();
    expect(screen.queryByText('What is the valuation range?')).toBeNull();
    expect(screen.queryByText('Financial Performance')).toBeNull();
    expect(await screen.findByText('1 event')).toBeInTheDocument();
  });

  it('groups file, folder, and data-room events under Documents', async () => {
    logAudit('file', 'Opened', 'CIM v3.pdf', { deal: 'Project Summit' });
    logAudit('folder', 'Opened', 'Financials', { deal: 'Project Summit' });
    logAudit('dataroom', 'Viewed', 'Cap table', { deal: 'Project Summit' });
    logAudit('chat', 'Asked', 'Summarise the data room', {
      deal: 'Project Summit',
    });

    render(<AuditTrail />);

    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));

    expect(screen.getByText('CIM v3.pdf')).toBeInTheDocument();
    expect(screen.getByText('Financials')).toBeInTheDocument();
    expect(screen.getByText('Cap table')).toBeInTheDocument();
    expect(screen.queryByText('Summarise the data room')).toBeNull();
    expect(await screen.findByText('3 events')).toBeInTheDocument();
  });
});

describe('AuditTrail — live + empty', () => {
  it('appends an event logged after mount, live', async () => {
    render(<AuditTrail />);
    expect(screen.queryByText('Live activity target')).toBeNull();

    act(() => {
      logAudit('nav', 'Opened', 'Live activity target', {
        deal: 'Project Summit',
      });
    });

    expect(
      await screen.findByText('Live activity target'),
    ).toBeInTheDocument();
  });

  it('shows the empty state when nothing has been logged', async () => {
    render(<AuditTrail />);
    // The empty copy waits for the platform read.
    expect(
      await screen.findByText(/No activity yet\. Actions you take across the deal/),
    ).toBeInTheDocument();
  });
});

describe('AuditTrail — Person column and export', () => {
  it('shows a Person column: the named actor on server rows, Conductia on system rows, You on local rows', async () => {
    vi.mocked(fetchServerAudit).mockResolvedValueOnce([
      {
        id: 'srv-1',
        ts: Date.now() - 1000,
        kind: 'platform',
        action: 'Sent despite a compliance flag',
        target: '1 recipient · via mock',
        deal: 'Project Summit',
        person: 'Storm Duncan',
        personId: 'other-1',
      },
      {
        id: 'srv-own',
        ts: Date.now() - 1500,
        kind: 'platform',
        action: 'Advanced the rail',
        target: 'Step 3 → 4',
        deal: 'Project Summit',
        person: 'Avery Stone',
        personId: 'me-1',
      },
      {
        id: 'srv-2',
        ts: Date.now() - 2000,
        kind: 'platform',
        action: 'Model assessed the step',
        target: 'Teaser',
        deal: 'Project Summit',
        person: 'Conductia',
      },
    ]);
    logAudit('chat', 'Asked', 'What is the valuation range?', {
      deal: 'Project Summit',
    });

    render(<AuditTrail />);

    const sent = (await screen.findByText('Sent despite a compliance flag')).closest('li')!;
    expect(within(sent).getByTestId('audit-row-person')).toHaveTextContent('Storm Duncan');
    // The person moved out of the grey detail: no row reads "by {name}".
    expect(screen.queryByText(/^by /)).toBeNull();

    // The signed-in person's own server row reads "You", not their name.
    const own = screen.getByText('Advanced the rail').closest('li')!;
    expect(within(own).getByTestId('audit-row-person')).toHaveTextContent(/^You$/);
    expect(screen.queryByText('Avery Stone')).toBeNull();
    // Assistive tech hears the column: "Person: You".
    expect(own.textContent).toContain('Person: You');

    const model = screen.getByText('Model assessed the step').closest('li')!;
    expect(within(model).getByTestId('audit-row-person')).toHaveTextContent('Conductia');

    const local = screen.getByText('What is the valuation range?').closest('li')!;
    expect(within(local).getByTestId('audit-row-person')).toHaveTextContent('You');

    expect(screen.getByText('Person')).toBeInTheDocument();
  });

  it('exports the merged trail as conductia-audit-<date>.json, with real names', async () => {
    vi.mocked(fetchServerAudit).mockResolvedValueOnce([
      {
        id: 'srv-own',
        ts: Date.now() - 1500,
        kind: 'platform',
        action: 'Advanced the rail',
        actionKey: 'advance',
        target: 'Step 3 → 4',
        deal: 'Project Summit',
        person: 'Avery Stone',
        personId: 'me-1',
      },
      {
        id: 'srv-draft',
        ts: Date.now() - 2500,
        kind: 'platform',
        action: 'Started a skill draft',
        actionKey: 'skill_authoring.draft_created',
        target: 'Skill builder',
        deal: 'Project Summit',
        person: 'Avery Stone',
        personId: 'me-1',
      },
    ]);
    logAudit('chat', 'Asked', 'Export me', { deal: 'Project Summit' });
    let exported: Blob | null = null;
    const createObjectURL = vi.fn((blob: Blob) => {
      exported = blob;
      return 'blob:audit';
    });
    const revokeObjectURL = vi.fn();
    const original = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    let downloaded = '';
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloaded = this.download;
      });

    render(<AuditTrail />);
    await screen.findByText('Advanced the rail');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    // The file names the person; "You" is only how the screen reads.
    const json = JSON.parse(await (exported as unknown as Blob).text()) as Array<{ person?: string }>;
    expect(json.map((e) => e.person)).toContain('Avery Stone');
    // Server rows export the stored action key; the screen label rides along.
    const rows = json as Array<{ action: string; label?: string; actionKey?: string }>;
    const draft = rows.find((e) => e.label === 'Started a skill draft');
    expect(draft?.action).toBe('skill_authoring.draft_created');
    expect(draft?.actionKey).toBeUndefined();
    expect(rows.find((e) => e.label === 'Asked')?.action).toBe('Asked');
    expect(downloaded).toMatch(/^conductia-audit-\d{4}-\d{2}-\d{2}\.json$/);
    click.mockRestore();
    Object.assign(URL, original);
  });
});

const SERVER_ROWS = () => [
  {
    id: 'srv-send',
    ts: Date.now() - 1000,
    kind: 'platform' as const,
    action: 'Sent an outbound message',
    actionKey: 'send',
    target: '1 recipient · via noop',
    deal: 'Project Summit',
    person: 'Avery Stone',
    personId: 'me-1',
    serverDetail: {
      recipients: 1,
      recipientReview: { recipients: [{ email: 'ext1@outside.test', reason: 'not_on_deal' }] },
    },
  },
  {
    id: 'srv-override',
    ts: Date.now() - 2000,
    kind: 'platform' as const,
    action: 'Confirmed an unverified email domain for an invitation',
    actionKey: 'invite_domain_override',
    target: 'new@tidewater.test',
    deal: 'Project Summit',
    person: 'Pat Rivera',
    personId: 'other-1',
    serverDetail: { outcome: 'confirmed', classification: 'unverified', email: 'new@tidewater.test' },
  },
  {
    id: 'srv-view',
    ts: Date.now() - 3000,
    kind: 'dataroom' as const,
    action: 'Viewed a document',
    actionKey: 'view',
    target: 'CIM.pdf',
    deal: 'Project Summit',
    person: 'Pat Rivera',
    personId: 'other-1',
    serverDetail: null,
  },
];

function captureExport() {
  let exported: Blob | null = null;
  const createObjectURL = vi.fn((blob: Blob) => {
    exported = blob;
    return 'blob:audit';
  });
  const revokeObjectURL = vi.fn();
  const original = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  return {
    revokeObjectURL,
    rows: async () => JSON.parse(await (exported as unknown as Blob).text()) as Array<Record<string, unknown>>,
    restore: () => {
      click.mockRestore();
      Object.assign(URL, original);
    },
  };
}

describe('AuditTrail — a failed platform read', () => {
  it('states the failure with Retry, never "0 events" or "No activity yet", and disables Export with the reason', async () => {
    vi.mocked(fetchServerAudit).mockResolvedValueOnce(null);
    render(<AuditTrail />);
    expect(await screen.findByText('The audit trail could not be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText(/No activity yet/)).toBeNull();
    expect(screen.queryByTestId('audit-event-count')).toBeNull();
    expect(screen.queryByText(/0 events/)).toBeNull();
    const exportButton = screen.getByRole('button', { name: /^Export/ });
    expect(exportButton).toBeDisabled();
    // One failed read, one failure line (S6R4-03): Export points at it.
    expect(screen.queryByText('The platform trail could not be loaded.')).toBeNull();
    expect(screen.getAllByText('The audit trail could not be loaded.')).toHaveLength(1);
    expect(exportButton).toHaveAccessibleDescription('The audit trail could not be loaded.');
    expect(screen.queryByText('Nothing to export yet.')).toBeNull();
  });

  it('keeps browser-local rows under the banner, never alone as the record', async () => {
    vi.mocked(fetchServerAudit).mockResolvedValueOnce(null);
    logAudit('chat', 'Asked', 'Local only row', { deal: 'Project Summit' });
    render(<AuditTrail />);
    expect(await screen.findByText('The audit trail could not be loaded.')).toBeInTheDocument();
    expect(screen.getByText('Local only row')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Export/ })).toBeDisabled();
  });

  it('Retry reads the platform trail again', async () => {
    vi.mocked(fetchServerAudit).mockResolvedValueOnce(null).mockResolvedValueOnce(SERVER_ROWS());
    render(<AuditTrail />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Sent an outbound message')).toBeInTheDocument();
    expect(screen.queryByText('The audit trail could not be loaded.')).toBeNull();
    expect(screen.getByTestId('audit-event-count')).toHaveTextContent('3 events');
  });

  it('an empty platform trail is empty, not failed', async () => {
    vi.mocked(fetchServerAudit).mockResolvedValueOnce([]);
    render(<AuditTrail />);
    expect(await screen.findByText(/No activity yet/)).toBeInTheDocument();
    expect(screen.queryByText('The audit trail could not be loaded.')).toBeNull();
    expect(screen.getByTestId('audit-event-count')).toHaveTextContent('0 events');
  });

  it('while the read is pending, Export points at the loading line (S6R4-R2 M-2)', async () => {
    vi.mocked(fetchServerAudit).mockReturnValueOnce(new Promise(() => {}));
    render(<AuditTrail />);
    expect(await screen.findByText('Loading the audit trail.')).toBeInTheDocument();
    const exportButton = screen.getByRole('button', { name: 'Export' });
    expect(exportButton).toBeDisabled();
    expect(exportButton).toHaveAccessibleDescription('Loading the audit trail.');
  });

  it('an empty trail disables Export with a visible reason it points at (S6R4-03)', async () => {
    vi.mocked(fetchServerAudit).mockResolvedValueOnce([]);
    render(<AuditTrail />);
    expect(await screen.findByText('Nothing to export yet.')).toBeInTheDocument();
    const exportButton = screen.getByRole('button', { name: 'Export' });
    expect(exportButton).toBeDisabled();
    expect(exportButton).toHaveAccessibleDescription('Nothing to export yet.');
  });

  it('a trail with rows offers Export with no reason line', async () => {
    vi.mocked(fetchServerAudit).mockResolvedValueOnce(SERVER_ROWS());
    render(<AuditTrail />);
    await screen.findByText('Sent an outbound message');
    const exportButton = screen.getByRole('button', { name: 'Export' });
    expect(exportButton).toBeEnabled();
    expect(exportButton).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText('Nothing to export yet.')).toBeNull();
  });
});

describe('AuditTrail — a deal you are not on', () => {
  it('a refused read (the route\'s 404) is the shared not-on-deal state, never "0 events" or a disabled Export', async () => {
    useParamsMock.projectId = 'NOPEX-2026-999';
    vi.mocked(fetchServerAudit).mockResolvedValueOnce('not-on-deal');
    render(<AuditTrail />);
    expect(await screen.findByText('You are not on this deal.')).toBeInTheDocument();
    // Audit keeps its own h1 and gains none (S6R5-06).
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Audit Trail' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the Conductor Center' })).toHaveAttribute('href', '/projects');
    expect(screen.queryByText(/No activity yet/)).toBeNull();
    expect(screen.queryByTestId('audit-event-count')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Export/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByText('Loading the audit trail.')).toBeNull();
  });

  it('a 5xx keeps the failed state with Try again, never the not-on-deal state', async () => {
    useParamsMock.projectId = 'NOPEX-2026-999';
    vi.mocked(fetchServerAudit).mockResolvedValueOnce(null);
    render(<AuditTrail />);
    expect(await screen.findByText('The audit trail could not be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('You are not on this deal.')).toBeNull();
  });

  it('a deal in the viewer\'s own list with no server record keeps its local register', async () => {
    vi.mocked(fetchServerAudit).mockResolvedValueOnce('not-on-deal');
    render(<AuditTrail />);
    expect(await screen.findByText(/No activity yet/)).toBeInTheDocument();
    expect(screen.queryByText('You are not on this deal.')).toBeNull();
  });
});

describe('AuditTrail — export carries the record', () => {
  it('carries each server row\'s raw detail, null on local rows, and revokes the URL', async () => {
    vi.mocked(fetchServerAudit).mockResolvedValueOnce(SERVER_ROWS());
    logAudit('chat', 'Asked', 'Local row', { deal: 'Project Summit', detail: 'context' });
    const capture = captureExport();
    render(<AuditTrail />);
    await screen.findByText('Sent an outbound message');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    const rows = await capture.rows();
    const sendRow = rows.find((r) => r.action === 'send') as { detail: { recipientReview: { recipients: Array<{ email: string }> } } };
    expect(sendRow.detail.recipientReview.recipients[0].email).toBe('ext1@outside.test');
    const override = rows.find((r) => r.action === 'invite_domain_override') as { detail: { outcome: string }; label: string };
    expect(override.detail.outcome).toBe('confirmed');
    expect(override.label).toBe('Confirmed an unverified email domain for an invitation');
    expect(rows.find((r) => r.action === 'view')?.detail).toBeNull();
    const local = rows.find((r) => r.label === 'Asked');
    expect(local?.detail).toBeNull();
    // A row with no stored key exports its screen text as the action.
    expect(local?.action).toBe('Asked');
    expect(rows.every((r) => !('serverDetail' in r) && !('actionKey' in r))).toBe(true);
    expect(capture.revokeObjectURL).toHaveBeenCalledWith('blob:audit');
    capture.restore();
  });

  it('with a filter on, the button reads "Export all (N)" and the file holds every row', async () => {
    vi.mocked(fetchServerAudit).mockResolvedValueOnce(SERVER_ROWS());
    const capture = captureExport();
    render(<AuditTrail />);
    await screen.findByText('Sent an outbound message');
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    expect(screen.getByTestId('audit-event-count')).toHaveTextContent('1 event');
    fireEvent.click(screen.getByRole('button', { name: 'Export all (3)' }));
    expect(await capture.rows()).toHaveLength(3);
    capture.restore();
  });
});

describe('AuditTrail — own rows before the user is known', () => {
  it('never shows the signed-in person\'s real name while useCurrentUser is pending', async () => {
    userReady.current = false;
    vi.mocked(fetchServerAudit).mockResolvedValueOnce(SERVER_ROWS());
    render(<AuditTrail />);
    const own = (await screen.findByText('Sent an outbound message')).closest('li')!;
    expect(within(own).getByTestId('audit-row-person')).toHaveTextContent(/^$/);
    expect(screen.queryByText('Avery Stone')).toBeNull();
  });
});

describe('AuditTrail — header', () => {
  it('does not repeat "The compliance record." under the Compliance record eyebrow', () => {
    render(<AuditTrail />);
    expect(screen.getByText('Compliance record')).toBeInTheDocument();
    expect(screen.queryByText(/The compliance record\./)).toBeNull();
  });
});

describe('AuditTrail — while the platform read is pending', () => {
  it('shows a loading line, never "0 events" or "No activity yet"', async () => {
    let resolve!: (rows: never[]) => void;
    vi.mocked(fetchServerAudit).mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    render(<AuditTrail />);
    expect(screen.getByText('Loading the audit trail.')).toBeInTheDocument();
    expect(screen.queryByTestId('audit-event-count')).toBeNull();
    expect(screen.queryByText(/No activity yet/)).toBeNull();
    await act(async () => resolve([]));
    expect(screen.queryByText('Loading the audit trail.')).toBeNull();
    expect(screen.getByText(/No activity yet/)).toBeInTheDocument();
    expect(screen.getByTestId('audit-event-count')).toHaveTextContent('0 events');
  });
});
