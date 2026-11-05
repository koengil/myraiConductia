import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION } from '../src/lib/constants/audit';
import { toAuditEvent, type ServerAuditRow } from '../src/lib/audit/serverAudit';

const row = (action: string, detail: Record<string, unknown>): ServerAuditRow => ({
  id: 'a1',
  ts: '2026-09-11T12:00:00Z',
  action,
  document_id: null,
  detail,
  actor: { id: 'u1', full_name: 'Storm Duncan', display_name: null },
});

describe('audit trail rail labels', () => {
  it('keeps the seq-to-seq advance label when both ends carry a seq', () => {
    const event = toAuditEvent(
      row('advance', { from: 11, to: 12, fromStepKey: 'p2-s11', toStepKey: 'p2-s12' }),
      'Project Rail',
    );
    expect(event.action).toBe('Advanced the rail');
    expect(event.target).toBe('Step 11 → 12');
  });

  it('names the end of the rail when an advance leaves no active step', () => {
    const event = toAuditEvent(
      row('advance', { from: 29, to: null, fromStepKey: 'p2-s29', toStepKey: null }),
      'Project Rail',
    );
    // Named by its step, never by seq.
    expect(event.target).toBe('Timeline → No active step');
  });

  it('names a custom step by its title when it has no seq', () => {
    const event = toAuditEvent(
      row('advance', {
        from: null,
        to: 30,
        fromStepKey: 'custom:abc',
        fromTitle: 'Weekly project update',
        toStepKey: 'p2-s30',
        toTitle: null,
      }),
      'Project Rail',
    );
    expect(event.target).toBe('Weekly project update → Working Group List');
  });

  it('labels a rail skip as a platform event named by the catalogue title', () => {
    const event = toAuditEvent(
      row('update', {
        rail: 'skip',
        stepId: 'uuid-1',
        stepKey: 'p2-s29',
        approver: 'u1',
        reason: 'Handled off platform',
      }),
      'Project Rail',
    );
    expect(event.kind).toBe('platform');
    expect(event.action).toBe('Skipped a step');
    expect(event.target).toBe('Timeline');
  });

  it('labels a removal of a custom step by its recorded title', () => {
    const event = toAuditEvent(
      row('update', {
        rail: 'remove',
        stepId: 'uuid-2',
        stepKey: 'custom:abc',
        title: 'Weekly project update',
      }),
      'Project Rail',
    );
    expect(event.action).toBe('Removed a step');
    expect(event.target).toBe('Weekly project update');
  });

  it('names a restored origination step from the full census catalogue', () => {
    const event = toAuditEvent(
      row('update', { rail: 'restore', stepId: 'uuid-3', stepKey: 'p1-s1', title: null }),
      'Project Rail',
    );
    expect(event.action).toBe('Restored a step');
    expect(event.target).toBe('Target Universe');
  });

  it('never shows a raw update for a rail row recorded without a step key', () => {
    const event = toAuditEvent(row('update', { rail: 'remove', stepId: 'uuid-5' }), 'Project Rail');
    expect(event.action).toBe('Removed a step');
    expect(event.target).toBe('');
  });
});

describe('audit trail skill run labels', () => {
  it('reads a recorded run as a sentence naming the step', () => {
    const event = toAuditEvent(
      row('create', {
        kind: 'skill_run',
        stepKey: 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
        title: 'Weekly project update',
        runId: '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11',
        outcome: 'succeeded',
      }),
      'Project Rail',
    );
    expect(event.action).toBe('Ran a skill on a step');
    expect(event.target).toBe('Weekly project update · succeeded');
  });

  it('reads a trigger row, which carries no outcome yet, as a start', () => {
    const event = toAuditEvent(
      row('create', {
        kind: 'skill_run',
        stepKey: 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
        title: 'Weekly project update',
        runId: '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11',
      }),
      'Project Rail',
    );
    expect(event.action).toBe('Started a skill on a step');
    expect(event.target).toBe('Weekly project update');
  });

  it('falls back to a catalog step title and says when a run failed', () => {
    const event = toAuditEvent(
      row('create', { kind: 'skill_run', stepKey: 'p1-s9', outcome: 'failed' }),
      'Project Rail',
    );
    expect(event.action).toBe('Ran a skill on a step');
    expect(event.target).toContain('failed');
  });

  it('never leaks the step id when the title and the catalog both miss', () => {
    const event = toAuditEvent(
      row('create', { kind: 'skill_run', stepKey: 'custom:unknown', outcome: 'succeeded' }),
      'Project Rail',
    );
    expect(event.target).toBe('This step · succeeded');
  });

  it('reads a revision start, which carries no outcome yet, as a start of revising', () => {
    const event = toAuditEvent(
      row('create', {
        kind: 'skill_run_revision',
        phase: 'started',
        stepKey: 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
        title: 'Weekly project update',
      }),
      'Project Rail',
    );
    expect(event.action).toBe('Started revising a skill output');
    expect(event.target).toBe('Weekly project update');
  });

  it('reads a recorded revision as a revised output with its outcome', () => {
    const event = toAuditEvent(
      row('create', {
        kind: 'skill_run_revision',
        phase: 'recorded',
        revisionKind: 'edits',
        stepKey: 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
        title: 'Weekly project update',
        outcome: 'succeeded',
      }),
      'Project Rail',
    );
    expect(event.action).toBe('Revised a skill output');
    expect(event.target).toBe('Weekly project update · succeeded');
  });

  it('reads a recorded restore as a restored version', () => {
    const event = toAuditEvent(
      row('create', {
        kind: 'skill_run_revision',
        phase: 'recorded',
        revisionKind: 'restore',
        stepKey: 'custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
        title: 'Weekly project update',
        outcome: 'succeeded',
      }),
      'Project Rail',
    );
    expect(event.action).toBe('Restored a version of a skill output');
    expect(event.target).toBe('Weekly project update · succeeded');
  });

  it('labels the saved rail template actions, never the raw action', () => {
    const labels = {
      [AUDIT_ACTION.RAIL_TEMPLATE_CREATED]: 'Saved the rail as a template',
      [AUDIT_ACTION.RAIL_TEMPLATE_REPLACED]: 'Replaced a saved rail template',
      [AUDIT_ACTION.RAIL_TEMPLATE_APPLIED]: 'Created the deal from a rail template',
    };
    for (const [action, label] of Object.entries(labels)) {
      const event = toAuditEvent(
        row(action, { templateId: 't1', revisionId: 'r1', stepCount: 61, skillCount: 2 }),
        'Project Rail',
      );
      expect(event.kind).toBe('platform');
      expect(event.action).toBe(label);
      expect(event.target).toBe('61 steps');
    }
    expect(toAuditEvent(row(AUDIT_ACTION.RAIL_TEMPLATE_APPLIED, {}), 'Project Rail').target).toBe(
      'Rail template',
    );
  });
});

describe('audit trail skill builder labels', () => {
  it('names every skill builder row in words, never by its stored action key', () => {
    for (const action of [
      'skill_authoring.draft_created',
      'skill_authoring.draft_archived',
      'skill_authoring.message_admitted',
      'skill_authoring.attempt_transitioned',
      'skill_authoring.candidate_selected',
      'skill_authoring.access_denied',
    ]) {
      const event = toAuditEvent(row(action, {}), 'Project Rail');
      expect(event.action).not.toContain('skill_authoring');
      expect(event.action).not.toContain('_');
      expect(event.target).toBe('Skill builder');
      // The stored key stays on the event for the export.
      expect(event.actionKey).toBe(action);
    }
    expect(toAuditEvent(row('skill_authoring.draft_created', {}), 'Project Rail').action).toBe(
      'Started a skill draft',
    );
  });
});
