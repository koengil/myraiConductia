import { describe, expect, it } from 'vitest';

import {
  ALL_TEAM_INBOXES,
  CHECK_REASON_LABEL,
  driftSentence,
  NO_FINISH_RECORDED,
  REMOVED_INBOX,
  SERVICE_IDENTITY_LABEL,
  toFirmAuditEvent,
  type FirmAuditEvent,
} from '../src/lib/audit/firmAudit';
import { describeAuditRow } from '../src/lib/audit/serverAudit';
import { dateLabel } from '../src/components/discovery/IngestionHealth';
import { DISCOVERY_AUDIT_ACTION, type DiscoveryAuditAction } from '../src/lib/constants/audit';
import { TEAM_MAILBOX_AUDIT_VIEW, TEAM_MAILBOX_CHECK_REASONS } from '../src/lib/constants/discovery';
import type { TeamMailboxAuditInbox, TeamMailboxAuditRow } from '../src/lib/discovery/api';

const OPEN = '00000000-0000-4000-8000-0000000000a1';
const CLOSED = '00000000-0000-4000-8000-0000000000a2';
const SOURCE = '00000000-0000-4000-8000-0000000000b1';

const inboxes: TeamMailboxAuditInbox[] = [
  { id: OPEN, address: 'deals@bank.example', open: true },
  { id: CLOSED, address: null, open: false },
];

function row(action: DiscoveryAuditAction, overrides: Partial<TeamMailboxAuditRow> = {}): TeamMailboxAuditRow {
  return {
    id: '00000000-0000-4000-8000-0000000000c1',
    ts: '2026-10-21T10:42:00.123456+00:00',
    action,
    actorType: 'service',
    actorName: null,
    serviceIdentity: 'discovery-worker',
    subjectName: null,
    inboxId: OPEN,
    detail: { teamMailboxId: OPEN },
    ...overrides,
  };
}

const event = (r: TeamMailboxAuditRow, view: Parameters<typeof toFirmAuditEvent>[2] = undefined) =>
  toFirmAuditEvent(r, inboxes, view);

const A = DISCOVERY_AUDIT_ACTION;

describe('firm audit actor labels (design R12)', () => {
  it('names each known service by its label', () => {
    expect(SERVICE_IDENTITY_LABEL).toEqual({
      'discovery-worker': 'Discovery worker',
      'team-mailbox': 'Team inbox access rule',
      'm365-recorder': 'M365 recorder',
      'mailbox-consent': 'Mailbox consent',
      'model-gateway': 'Model gateway',
      'discovery-tenant-approvals': 'Owner approval',
    });
    for (const [identity, label] of Object.entries(SERVICE_IDENTITY_LABEL)) {
      expect(event(row(A.TEAM_MAILBOX_CHECKED, { serviceIdentity: identity }))).toMatchObject({
        actorLabel: label,
        actorCode: null,
      });
    }
    expect(
      event(row(A.TEAM_MAILBOX_CHECKED, { actorType: 'model', serviceIdentity: 'model-gateway' })).actorLabel,
    ).toBe('Model gateway');
  });

  it('shows an unknown code-shaped service by its identity, and a missing one as Service', () => {
    expect(event(row(A.MAILBOX_REFUSED, { serviceIdentity: 'rehearsal-probe' }))).toMatchObject({
      actorLabel: 'Service rehearsal-probe',
      actorCode: 'rehearsal-probe',
    });
    // The RPC returns null for a free-text identity; so does a row with none.
    expect(event(row(A.MAILBOX_REFUSED, { serviceIdentity: null }))).toMatchObject({ actorLabel: 'Service', actorCode: null });
    // A service never takes a key of the object prototype for a label.
    expect(event(row(A.MAILBOX_REFUSED, { serviceIdentity: 'constructor' })).actorLabel).toBe('Service constructor');
  });

  it('names a person as "by <name>", and a user row without a name plainly', () => {
    const by = event(row(A.TEAM_MAILBOX_CONNECTED, { actorType: 'user', actorName: 'Storm Duncan', serviceIdentity: null }));
    expect(by).toMatchObject({ actorLabel: 'by Storm Duncan', actorCode: null });
    const nameless = event(row(A.TEAM_MAILBOX_CONNECTED, { actorType: 'user', actorName: null, serviceIdentity: null }));
    expect(nameless.actorLabel).toBe('by a user');
  });
});

describe('firm audit inbox cell', () => {
  it('shows an open inbox by its address, a firm event as All team inboxes, and a closed one as Removed inbox', () => {
    expect(event(row(A.TEAM_MAILBOX_CHECKED))).toMatchObject({ inbox: 'deals@bank.example', inboxKind: 'address' });
    expect(event(row(A.ALLOWLIST_DRIFT, { inboxId: null, detail: { provider: 'google', status: 'unavailable' } }))).toMatchObject({
      inbox: ALL_TEAM_INBOXES,
      inboxKind: 'firm',
    });
    expect(event(row(A.TEAM_MAILBOX_DISCONNECTED, { inboxId: CLOSED }))).toMatchObject({
      inbox: REMOVED_INBOX,
      inboxKind: 'removed',
    });
    expect(event(row(A.TEAM_MAILBOX_CHECKED, { inboxId: '00000000-0000-4000-8000-0000000000ff' })).inbox).toBe(REMOVED_INBOX);
  });
});

describe('firm audit action and detail', () => {
  // Drift has its own sentences, and an access change or a refused read of a team inbox is said of the team inbox.
  it('takes the action label from the deal trail describer for every other action', () => {
    for (const action of [
      A.TEAM_MAILBOX_CONNECTED,
      A.TEAM_MAILBOX_CHECKED,
      A.TEAM_MAILBOX_MEMBER_ADDED,
      A.TEAM_MAILBOX_MEMBER_REMOVED,
      A.TEAM_MAILBOX_DISCONNECTED,
      A.READER_PASS_STARTED,
      A.READER_PASS_FINISHED,
      A.CANDIDATE_PROPOSED,
    ]) {
      const r = row(action);
      const described = describeAuditRow({ id: r.id, ts: r.ts, action, document_id: null, detail: r.detail, actor: null });
      expect(event(r).action).toBe(described.action);
    }
  });

  it('shows a check verdict as a chip, and a refusal by its short reason', () => {
    expect(event(row(A.TEAM_MAILBOX_CHECKED, { detail: { teamMailboxId: OPEN, status: 'verified' } }))).toMatchObject({
      action: 'Checked a team inbox address',
      target: '',
      verdict: { label: 'Verified', tone: 'positive' },
    });
    for (const reason of TEAM_MAILBOX_CHECK_REASONS) {
      expect(event(row(A.TEAM_MAILBOX_CHECKED, { detail: { teamMailboxId: OPEN, status: 'refused', reason } }))).toMatchObject({
        target: CHECK_REASON_LABEL[reason],
        verdict: { label: 'Refused', tone: 'negative' },
      });
    }
    expect(CHECK_REASON_LABEL.directory_denied).toBe('Directory read not granted');
    // A code this table does not know still reads plainly.
    expect(event(row(A.TEAM_MAILBOX_CHECKED, { detail: { status: 'refused', reason: 'new_code' } })).target).toBe('New code');
  });

  it('names the person a membership row is about, and why a removal happened', () => {
    const added = event(
      row(A.TEAM_MAILBOX_MEMBER_ADDED, { actorType: 'user', actorName: 'Storm Duncan', serviceIdentity: null, subjectName: 'Priya Shah' }),
    );
    expect(added).toMatchObject({ target: 'Priya Shah', actorLabel: 'by Storm Duncan' });
    const removed = event(
      row(A.TEAM_MAILBOX_MEMBER_REMOVED, {
        serviceIdentity: 'team-mailbox',
        subjectName: 'Alex Moreno',
        detail: { teamMailboxId: OPEN, reason: 'seat_lost' },
      }),
    );
    expect(removed).toMatchObject({ target: 'Alex Moreno · seat lost', actorLabel: 'Team inbox access rule' });
    expect(event(row(A.TEAM_MAILBOX_MEMBER_ADDED)).target).toBe('A person');
  });

  it('says what a disconnect, a pause and a first-read window changed', () => {
    expect(event(row(A.TEAM_MAILBOX_DISCONNECTED, { detail: { reason: 'never_verified' } })).target).toBe('Never verified');
    expect(event(row(A.MAILBOX_ACCESS_CHANGED, { detail: { change: 'paused' } }))).toMatchObject({
      action: 'Paused reading the team inbox',
      target: '',
    });
    const windowSet = event(
      row(A.MAILBOX_ACCESS_CHANGED, { detail: { change: 'window_set', from: '2026-07-01', to: '2026-09-01' } }),
    );
    expect(windowSet.action).toBe('Set how far back the team inbox is read');
    // The days read as the Ingestion health window does, never as raw YYYY-MM-DD.
    expect(windowSet.target).toBe(`First read from ${dateLabel('2026-09-01')}, was ${dateLabel('2026-07-01')}`);
    expect(windowSet.target).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(event(row(A.MAILBOX_ACCESS_CHANGED, { detail: { change: 'window_set', to: '2026-09-01' } })).target).toBe(
      `First read from ${dateLabel('2026-09-01')}`,
    );
    expect(event(row(A.MAILBOX_ACCESS_CHANGED, { detail: { change: 'something_new' } })).target).toBe('Something new');
  });

  it('says a pause, a resume, a restart, a window and a refused read of the team inbox, not of "a mailbox"', () => {
    const action = (a: DiscoveryAuditAction, detail: TeamMailboxAuditRow['detail']) => event(row(a, { detail })).action;
    expect(action(A.MAILBOX_ACCESS_CHANGED, { change: 'resumed' })).toBe('Resumed reading the team inbox');
    expect(action(A.MAILBOX_ACCESS_CHANGED, { change: 'restarted' })).toBe('Restarted reading the team inbox');
    expect(action(A.MAILBOX_ACCESS_CHANGED, { change: 'something_new' })).toBe('Changed how the team inbox is read');
    expect(action(A.MAILBOX_REFUSED, { reason: 'team_mailbox_unverified' })).toBe('Refused a team inbox read');
    // With no inbox the deal trail's own label stands.
    expect(event(row(A.MAILBOX_ACCESS_CHANGED, { inboxId: null, detail: { change: 'paused' } })).action).toBe(
      'Paused deal discovery reading a mailbox',
    );
    expect(event(row(A.MAILBOX_REFUSED, { inboxId: null, detail: { reason: 'x' } })).action).toBe('Refused a mailbox read');
  });

  it('shows a refused read by its reason, and its purpose when it was not a provider read', () => {
    expect(
      event(row(A.MAILBOX_REFUSED, { detail: { reason: 'team_mailbox_unverified', purpose: 'provider_read' } })).target,
    ).toBe('Team mailbox unverified');
    expect(event(row(A.MAILBOX_REFUSED, { detail: { reason: 'team_mailbox_unverified', purpose: 'agent_tool' } })).target).toBe(
      'Team mailbox unverified · for agent tool',
    );
  });

  it('gives the three drift sentences, with what the row says about this inbox (R16)', () => {
    expect(driftSentence('unavailable', 'google')).toBe("Couldn't read the Google ingest group");
    expect(driftSentence('drift', 'google')).toBe('Google ingest group differs from the allowlist');
    expect(driftSentence('in_sync', 'google')).toBe('Google ingest group matches the allowlist again');

    const firm = (detail: TeamMailboxAuditRow['detail']) => event(row(A.ALLOWLIST_DRIFT, { inboxId: null, detail }));
    expect(firm({ provider: 'google', status: 'unavailable' })).toMatchObject({
      action: "Couldn't read the Google ingest group",
      target: '',
      verdict: { label: 'Unavailable', tone: 'hold' },
    });
    expect(firm({ provider: 'google', status: 'drift', thisInbox: 'missing' })).toMatchObject({
      action: 'Google ingest group differs from the allowlist',
      target: 'This inbox is missing from the group',
    });
    expect(firm({ provider: 'google', status: 'drift', thisInbox: 'extra' }).target).toBe(
      'This inbox is in the group but not on the allowlist',
    );
    expect(firm({ provider: 'google', status: 'drift', thisInbox: 'both' }).target).toBe(
      'One team inbox is missing from the group, another is in it but not on the allowlist',
    );
    expect(firm({ provider: 'google', status: 'drift' }).target).toBe('');
    expect(firm({ provider: 'google', status: 'in_sync' }).verdict).toEqual({ label: 'In sync', tone: 'positive' });
  });

  it('shows a finished pass by its counts, and a started one with no finish in the notable view', () => {
    const passDetail = { sourceId: SOURCE, status: 'complete', fetched: 12, excluded: 3, stored: 9 };
    expect(event(row(A.READER_PASS_FINISHED, { detail: passDetail })).target).toBe('12 fetched, 3 excluded by policy, 9 stored');
    expect(
      event(row(A.READER_PASS_FINISHED, { detail: { sourceId: SOURCE, status: 'page_limit', fetched: 4, excluded: 0, stored: 4 } })).target,
    ).toBe('Page limit · 4 fetched, 0 excluded by policy, 4 stored');
    expect(event(row(A.READER_PASS_FINISHED, { detail: { sourceId: SOURCE, status: 'failed' } })).target).toBe('Failed');

    const started = row(A.READER_PASS_STARTED, { detail: { sourceId: SOURCE } });
    expect(event(started, TEAM_MAILBOX_AUDIT_VIEW.READS)).toMatchObject({ action: 'Started a mailbox read', target: '' });
    expect(event(started, TEAM_MAILBOX_AUDIT_VIEW.READS_NOTABLE).target).toBe(NO_FINISH_RECORDED);
  });

  it('shows a proposed deal by its evidence count, never a name', () => {
    expect(event(row(A.CANDIDATE_PROPOSED, { detail: { evidenceCount: 3 } }))).toMatchObject({
      action: 'Proposed a deal candidate',
      target: '3 messages',
    });
    expect(event(row(A.CANDIDATE_PROPOSED, { detail: { evidenceCount: 1 } })).target).toBe('1 message');
  });

  it('writes no em dash anywhere, and no address outside the Inbox cell', () => {
    const rows: TeamMailboxAuditRow[] = [
      row(A.TEAM_MAILBOX_CONNECTED, { actorType: 'user', actorName: 'Storm Duncan', serviceIdentity: null }),
      row(A.TEAM_MAILBOX_CHECKED, { detail: { status: 'refused', reason: 'alias' } }),
      row(A.TEAM_MAILBOX_MEMBER_REMOVED, { subjectName: 'Alex Moreno', detail: { reason: 'removed' } }),
      row(A.TEAM_MAILBOX_DISCONNECTED, { inboxId: CLOSED, detail: { reason: 'no_mail' } }),
      row(A.MAILBOX_ACCESS_CHANGED, { detail: { change: 'window_set', from: '2026-07-01', to: '2026-09-01' } }),
      row(A.MAILBOX_REFUSED, { detail: { reason: 'team_mailbox_unverified', purpose: 'search' } }),
      row(A.ALLOWLIST_DRIFT, { inboxId: null, detail: { provider: 'google', status: 'drift', thisInbox: 'missing' } }),
      row(A.READER_PASS_FINISHED, { detail: { status: 'refused', fetched: 0, stored: 0, excluded: 0 } }),
      row(A.CANDIDATE_PROPOSED, { detail: { evidenceCount: 2 } }),
    ];
    for (const r of rows) {
      const e: FirmAuditEvent = event(r);
      const shown = [e.action, e.target, e.actorLabel, e.verdict?.label ?? '', e.inbox].join(' | ');
      expect(shown).not.toContain('—');
      expect([e.action, e.target, e.actorLabel, e.verdict?.label ?? ''].join(' | ')).not.toContain('@');
    }
  });
});

// #173 G-01 (20261023110400): the AI passes over a team inbox and the owner's capability switches for the firm company.
describe('firm audit AI passes and capability switches (G-01)', () => {
  it('takes the action label from the deal trail describer', () => {
    for (const action of [A.TEAM_MAILBOX_PROPOSAL_STARTED, A.TEAM_MAILBOX_PROPOSAL_FINISHED, A.TENANT_APPROVAL_CHANGED]) {
      const r = row(action);
      const described = describeAuditRow({ id: r.id, ts: r.ts, action, document_id: null, detail: r.detail, actor: null });
      expect(event(r).action).toBe(described.action);
    }
  });

  it('says how a finished pass ended and what it asked, and nothing for a started one', () => {
    const finished = row(A.TEAM_MAILBOX_PROPOSAL_FINISHED, {
      detail: { teamMailboxId: OPEN, sourceId: SOURCE, path: 'recorded', outcome: 'complete', asked: 3, deal: 1, notDeal: 1, invalid: 1, failed: 0 },
    });
    expect(event(finished)).toMatchObject({
      target: 'Complete · 3 asked: 1 deal, 1 not a deal, 1 unreadable',
      inbox: 'deals@bank.example',
      verdict: null,
    });
    const failing = row(A.TEAM_MAILBOX_PROPOSAL_FINISHED, { detail: { outcome: 'failure_streak', asked: 20, deal: 0, notDeal: 0, invalid: 0, failed: 20 } });
    expect(event(failing).target).toBe('Failure streak · 20 asked: 0 deals, 0 not a deal, 0 unreadable, 20 failed');
    expect(event(row(A.TEAM_MAILBOX_PROPOSAL_FINISHED, { detail: { outcome: 'unclosed' } })).target).toBe('Unclosed');
    expect(event(row(A.TEAM_MAILBOX_PROPOSAL_STARTED, { detail: { path: 'recorded' } })).target).toBe('');
  });

  it('says what a rule detector pass read and found, under its inbox (G-07 slice 5)', () => {
    const pass = row(A.TEAM_MAILBOX_MILESTONES_DETECTED, { detail: { teamMailboxId: OPEN, items: 12, events: 3 } });
    expect(event(pass)).toMatchObject({ target: '12 read, 3 milestones found', inbox: 'deals@bank.example', verdict: null });
    expect(event(row(A.TEAM_MAILBOX_MILESTONES_DETECTED, { detail: { items: 1, events: 1 } })).target).toBe('1 read, 1 milestone found');
    expect(event(row(A.TEAM_MAILBOX_MILESTONES_DETECTED, { detail: {} })).target).toBe('');
  });

  it('shows a capability switch as a firm event: the capability, and an On or Off chip', () => {
    const on = row(A.TENANT_APPROVAL_CHANGED, {
      inboxId: null,
      serviceIdentity: 'discovery-tenant-approvals',
      detail: { capability: 'team_proposals', on: true },
    });
    expect(event(on)).toMatchObject({
      actorLabel: 'Owner approval',
      actorCode: null,
      target: 'Team proposals',
      verdict: { label: 'On', tone: 'positive' },
      inbox: ALL_TEAM_INBOXES,
      inboxKind: 'firm',
    });
    const off = row(A.TENANT_APPROVAL_CHANGED, { inboxId: null, detail: { capability: 'milestone_rules', on: false } });
    expect(event(off)).toMatchObject({ target: 'Milestone rules', verdict: { label: 'Off', tone: 'neutral' } });
    expect(event(row(A.TENANT_APPROVAL_CHANGED, { inboxId: null, detail: { capability: 'firm_name_alias' } })).verdict).toBeNull();
  });
});
