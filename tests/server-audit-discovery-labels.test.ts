import { describe, expect, it } from 'vitest';
import { DISCOVERY_AUDIT_ACTIONS } from '../src/lib/constants/audit';
import { describeAuditRow, toAuditEvent, type ServerAuditRow } from '../src/lib/audit/serverAudit';

const row = (action: string, detail: Record<string, unknown> | null): ServerAuditRow => ({
  id: 'a1',
  ts: '2026-09-25T12:00:00Z',
  action,
  document_id: null,
  detail,
  actor: null,
});

describe('audit trail discovery labels', () => {
  it('gives every discovery action a sentence label, never the raw action', () => {
    for (const action of DISCOVERY_AUDIT_ACTIONS) {
      const event = toAuditEvent(row(action, null), 'Project Falcon');
      expect(event.kind).toBe('platform');
      expect(event.action).not.toBe(action);
      expect(event.target).not.toBe('');
      expect(event.action).not.toMatch(/—/);
    }
  });

  it('exports the describer the deal trail uses, unchanged (#173 G-03)', () => {
    for (const action of DISCOVERY_AUDIT_ACTIONS) {
      const r = row(action, { teamMailboxId: 't-1', status: 'refused', reason: 'directory_denied' });
      const described = describeAuditRow(r);
      const event = toAuditEvent(r, 'Project Falcon');
      expect(described).toEqual({ kind: event.kind, action: event.action, target: event.target });
      expect(described.action).not.toMatch(/—/);
      expect(described.target).not.toMatch(/—/);
    }
  });

  it('names the assessed step by its catalogue title', () => {
    const event = toAuditEvent(
      row('discovery.stage_assessed', { stepId: 'p2-s29', modelCallId: 'm-1' }),
      'Project Falcon',
    );
    expect(event.action).toBe('Assessed the step');
    expect(event.target).toBe('Timeline');
  });

  it.each([
    ['model', 'Assessed the step from the model'],
    ['rules', 'Assessed the step from rules'],
    ['mixed', 'Assessed the step from model and rules'],
  ])('names an assessment\'s basis, so a CCO sees the model\'s part (%s, #173 G-07)', (basis, action) => {
    const event = toAuditEvent(row('discovery.stage_assessed', { stepId: 'p2-s29', basis }), 'Project Falcon');
    expect(event.action).toBe(action);
    expect(event.target).toBe('Timeline');
  });

  it('names no basis it does not know', () => {
    const event = toAuditEvent(row('discovery.stage_assessed', { stepId: 'p2-s29', basis: 'constructor' }), 'Project Falcon');
    expect(event.action).toBe('Assessed the step');
  });

  it('shows the correction and its reason', () => {
    const event = toAuditEvent(
      row('discovery.correction', { correction: 'override_station', reason: 'LOI signed last week' }),
      'Project Falcon',
    );
    expect(event.action).toBe('Corrected a discovery result');
    expect(event.target).toBe('Overrode the step · LOI signed last week');
  });

  it('names the correction the SQL wrote in detail.action, with no reason (G-02 TH3-6)', () => {
    const event = toAuditEvent(
      row('discovery.correction', { candidateId: 'c-1', correctionId: 'k-1', action: 'set_station' }),
      'Project Falcon',
    );
    expect(event.action).toBe('Corrected a discovery result');
    expect(event.target).toBe('Set the step');
    const accepted = toAuditEvent(
      row('discovery.correction', { candidateId: 'c-1', correctionId: 'k-1', action: 'accept_proposal' }),
      'Project Falcon',
    );
    expect(accepted.target).toBe('Accepted the model proposal');
  });

  it('names a rejected or merged candidate as the proposed deal, never the mandate', () => {
    const correction = (action: string) =>
      toAuditEvent(row('discovery.correction', { candidateId: 'c-1', correctionId: 'k-1', action }), 'Project Falcon').target;
    expect(correction('reject')).toBe('Rejected the proposed deal');
    expect(correction('merge')).toBe('Merged into another proposed deal');
  });

  it('labels a model proposal dismissal and its restore by counts, never the deal key or a name (G-02a)', () => {
    const dismissed = toAuditEvent(
      row('discovery.model_proposal_dismissed', {
        operationId: 'op-1',
        dismissalIds: ['d-1', 'd-2'],
        keyKind: 'm',
        sourceCount: 2,
        rowCount: 3,
      }),
      'Project Falcon',
    );
    expect(dismissed).toMatchObject({ kind: 'platform', action: 'Dismissed a model proposal', target: '3 proposals' });

    const restored = toAuditEvent(
      row('discovery.model_proposal_dismissal_restored', {
        dismissalIds: ['d-1', 'd-2'],
        operationIds: ['op-1'],
        requestedBy: 'u-1',
      }),
      'Project Falcon',
    );
    expect(restored).toMatchObject({
      kind: 'platform',
      action: 'Restored a dismissed model proposal',
      target: '2 dismissals',
    });

    // Even a detail that wrongly carried the key or a name would not surface it: the target is built from counts.
    const stray = toAuditEvent(
      row('discovery.model_proposal_dismissed', { rowCount: 1, dealKey: 'm:project-falcon', dealName: 'Project Falcon' }),
      'Project Falcon',
    );
    for (const event of [dismissed, restored, stray]) {
      expect(`${event.action} ${event.target}`).not.toMatch(/falcon|m:|c:/i);
    }
  });

  it('labels an accepted model proposal and its finish by counts, never the deal key or a name (G-02b)', () => {
    const requested = toAuditEvent(
      row('discovery.model_proposal_accept_requested', {
        operationId: 'op-1',
        requestIds: ['r-1'],
        sourceCount: 1,
        messageCount: 4,
        proposedStepId: 'p2-s26',
      }),
      'Project Falcon',
    );
    expect(requested).toMatchObject({
      kind: 'platform',
      action: 'Requested an accept of a model proposal',
      target: '4 emails from 1 source',
    });
    // A request is never worded as done: only the finish says so.
    expect(requested.action).not.toMatch(/^Accepted|finished/i);

    const finished = toAuditEvent(
      row('discovery.model_proposal_accept_finished', {
        requestId: 'r-1',
        operationId: 'op-1',
        outcome: 'done',
        found: 3,
        requested: 4,
        changed: 1,
        purged: 0,
      }),
      'Project Falcon',
    );
    expect(finished).toMatchObject({
      kind: 'platform',
      action: 'Finished reading the emails of an accepted model proposal',
      target: '3 of 4 emails',
    });

    // Even a detail that wrongly carried the key or a name would not surface it: the target is built from counts.
    const stray = toAuditEvent(
      row('discovery.model_proposal_accept_requested', { dealKey: 'm:project-falcon', dealName: 'Project Falcon' }),
      'Project Falcon',
    );
    for (const event of [requested, finished, stray]) {
      expect(`${event.action} ${event.target}`).not.toMatch(/falcon|m:|c:/i);
    }
  });

  it('labels a mailbox purge by its message count, never an address', () => {
    const event = toAuditEvent(
      row('discovery.mailbox_purged', { sourceId: 's-1', consentId: 'c-1', reason: 'withdrawn', items: 3 }),
      'Project Falcon',
    );
    expect(event.action).toBe('Deleted the mail stored from a mailbox');
    expect(event.target).toBe('3 messages');
  });

  it('labels a backstop collection by its message count', () => {
    const event = toAuditEvent(row('discovery.content_collected', { runId: 'r-1', items: 2 }), 'Project Falcon');
    expect(event.action).toBe('Deleted stored mail no mailbox holds');
    expect(event.target).toBe('2 messages');
  });

  it('labels a group-removal hold by its due count', () => {
    const event = toAuditEvent(row('discovery.group_removal_held', { due: 4, open: 5, maxShare: 0.3 }), 'Project Falcon');
    expect(event.action).toBe('Held group-removal withdrawals for an operator check');
    expect(event.target).toBe('4 consents');
  });

  it('labels a tenant purge by its message count', () => {
    const event = toAuditEvent(row('discovery.tenant_purged', { runId: 'r-1', sources: 4, items: 120 }), 'Project Falcon');
    expect(event.action).toBe("Deleted the firm's stored mail");
    expect(event.target).toBe('120 messages');
  });

  it('labels a retained mailbox without content', () => {
    const event = toAuditEvent(
      row('discovery.mailbox_retained', { sourceId: 's-1', consentId: 'c-1', reason: 'withdrawn' }),
      'Project Falcon',
    );
    expect(event.action).toBe('Kept the mail stored from a mailbox');
    expect(event.target).toBe('Mailbox');
  });

  it('labels a retention policy write by the lifecycle it sets', () => {
    const event = toAuditEvent(
      row('discovery.retention_policy_set', { old: null, new: { lifecycle: 'production', index_on_disconnect: 'keep' } }),
      'Project Falcon',
    );
    expect(event.action).toBe('Set the retention policy');
    expect(event.target).toBe('production');
  });

  it('labels the mailbox consent and refusal rows by address and reason, never content', () => {
    const consented = toAuditEvent(
      row('discovery.mailbox_consented', { address: 'storm.duncan@bank.example' }),
      'Project Falcon',
    );
    expect(consented.action).toBe('Connected a mailbox for deal discovery');
    expect(consented.target).toBe('storm.duncan@bank.example');

    const refused = toAuditEvent(
      row('discovery.mailbox_refused', { address: 'storm.duncan@bank.example', reason: 'no_consent', purpose: 'provider_read' }),
      'Project Falcon',
    );
    expect(refused.action).toBe('Refused a mailbox read');
    expect(refused.target).toBe('storm.duncan@bank.example · no consent');
  });

  it('labels the archive and the merge of an orphaned mailbox source by address, never content', () => {
    const archived = toAuditEvent(
      row('discovery.mailbox_source_archived', { address: 'storm.duncan@bank.example', archivedAddress: 'storm.duncan@bank.example~k3x' }),
      'Project Falcon',
    );
    expect(archived.action).toBe("Archived an earlier holder's mailbox history");
    expect(archived.target).toBe('storm.duncan@bank.example');

    const unified = toAuditEvent(
      row('discovery.mailbox_sources_unified', { address: 'storm.duncan@bank.example', moved: 2 }),
      'Project Falcon',
    );
    expect(unified.action).toBe('Merged archived mailbox history into the current mailbox');
    expect(unified.target).toBe('storm.duncan@bank.example');
  });

  it('labels a mailbox pause, resume and restart by address, never content', () => {
    const labelOf = (change: string) =>
      toAuditEvent(
        row('discovery.mailbox_access_changed', { change, provider: 'google', address: 'gina@bank.example' }),
        'Project Falcon',
      );
    expect(labelOf('paused')).toMatchObject({ action: 'Paused deal discovery reading a mailbox', target: 'gina@bank.example' });
    expect(labelOf('resumed')).toMatchObject({ action: 'Resumed deal discovery reading a mailbox', target: 'gina@bank.example' });
    expect(labelOf('restarted')).toMatchObject({
      action: 'Restarted deal discovery reading a mailbox',
      target: 'gina@bank.example',
    });
    // #353: a firm admin set the ingestion window before the first read.
    expect(labelOf('window_set')).toMatchObject({
      action: 'Set how far back deal discovery reads a mailbox',
      target: 'gina@bank.example',
    });
    // Connecting is the member's opt-in (discovery.mailbox_consented): this action never carries it.
    expect(labelOf('connected').action).toBe('Changed how deal discovery reads a mailbox');
    expect(labelOf('other').action).toBe('Changed how deal discovery reads a mailbox');
  });

  it('labels the team inbox actions without naming an address (ids and fixed codes only, #581)', () => {
    const connected = toAuditEvent(
      row('discovery.team_mailbox_connected', { teamMailboxId: 't-1', sourceId: 's-1', attestationVersion: 1 }),
      'Project Falcon',
    );
    expect(connected.action).toBe('Connected a team inbox for deal discovery');
    expect(connected.target).toBe('Team inbox');

    const checked = toAuditEvent(
      row('discovery.team_mailbox_checked', { teamMailboxId: 't-1', status: 'refused', reason: 'directory_denied' }),
      'Project Falcon',
    );
    expect(checked.action).toBe('Checked a team inbox address');
    expect(checked.target).toBe('refused · directory denied');

    const added = toAuditEvent(row('discovery.team_mailbox_member_added', { teamMailboxId: 't-1', userId: 'u-1' }), 'Project Falcon');
    expect(added.action).toBe('Gave a person access to a team inbox');
    const removed = toAuditEvent(
      row('discovery.team_mailbox_member_removed', { teamMailboxId: 't-1', userId: 'u-1', reason: 'removed' }),
      'Project Falcon',
    );
    expect(removed.action).toBe("Removed a person's access to a team inbox");

    const disconnected = toAuditEvent(
      row('discovery.team_mailbox_disconnected', { teamMailboxId: 't-1', sourceId: 's-1', reason: 'never_verified' }),
      'Project Falcon',
    );
    expect(disconnected.action).toBe('Removed a team inbox from deal discovery');
    expect(disconnected.target).toBe('never verified');
  });
});
