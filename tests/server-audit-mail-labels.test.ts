import { describe, expect, it } from 'vitest';
import { toAuditEvent, type ServerAuditRow } from '../src/lib/audit/serverAudit';

/*
 * The Audit Trail projection of the compliant mail channel's audit rows
 * (screen / send / release / reject). Before this mapping the four actions
 * fell through to the raw default ("screen", empty target) — invisible as
 * compliance evidence to anyone reading the register.
 */

const row = (action: string, detail: Record<string, unknown>): ServerAuditRow => ({
  id: 'a1',
  ts: '2026-08-17T12:00:00Z',
  action,
  document_id: null,
  // Both mail writers stamp `mode` — the mapper's positive discriminator for
  // mail-shaped screen rows. Tests spread it here; legacy-row tests omit it.
  detail: action === 'screen' ? { mode: 'full', ...detail } : detail,
  actor: { id: 'u1', full_name: 'Alex Chen', display_name: null },
});

describe('audit trail — mail action labels', () => {
  it('screen: compliant with sign-offs carries the verdict, AI flag, and count', () => {
    const e = toAuditEvent(
      row('screen', {
        verdict: 'compliant',
        llmChecked: true,
        preApproved: ['we guarantee', 'i promise'],
      }),
      'Project Sparrow',
    );
    expect(e.action).toBe('Screened an outbound message');
    expect(e.target).toBe('Compliant · AI-checked · 2 flagged terms signed off');
  });

  it('screen: an MNPI hold names its cause and the queue (legacy pre-#192 rows)', () => {
    const e = toAuditEvent(
      row('screen', { verdict: 'hold', holdCause: 'mnpi', llmChecked: false }),
      'Project Sparrow',
    );
    expect(e.target).toBe('Held (MNPI), sent to supervisory review · not AI-checked');
  });

  it('screen: a post-#192 MNPI read returned to the sender says so — no queue claim', () => {
    const e = toAuditEvent(
      row('screen', { verdict: 'hold', holdCause: 'mnpi', returned: true, llmChecked: false }),
      'Project Sparrow',
    );
    expect(e.target).toBe('Held (MNPI), returned to sender · not AI-checked');
  });

  it('screen: a send-as-is that REPLAYED the first screen says so (#192 slice 2b)', () => {
    const e = toAuditEvent(
      row('screen', {
        verdict: 'hold',
        holdCause: 'reputational',
        sentAsIs: true,
        llmChecked: true,
        replayed: true,
      }),
      'Project Sparrow',
    );
    // No second screen ran: the row applies the first screen's read, and the
    // label must not claim a fresh AI check happened on this request.
    expect(e.target).toBe(
      'Flagged at screening (reputational risk), sent anyway · first screen applied (AI-checked)',
    );
  });

  it('send: the send-as-is choice is the send row headline, in plain words', () => {
    const e = toAuditEvent(
      row('send', { recipients: 1, provider: 'mock', sentAsIs: true }),
      'Project Sparrow',
    );
    expect(e.action).toBe('Sent despite a compliance flag');
    expect(e.target).toBe('1 recipient · via mock');

    // The send row names the cause when the writer recorded it.
    const withCause = toAuditEvent(
      row('send', { recipients: 1, provider: 'mock', sentAsIs: true, holdCause: 'reputational' }),
      'Project Sparrow',
    );
    expect(withCause.action).toBe('Sent despite a compliance flag');
    expect(withCause.target).toBe('1 recipient · via mock · flagged for reputational risk');
  });

  it('send: a send-anyway request the recheck cleared is not an override', () => {
    const e = toAuditEvent(
      row('send', { recipients: 1, provider: 'mock', sentAsIsRequested: true }),
      'Project Sparrow',
    );
    expect(e.action).toBe('Sent an outbound message');
    expect(e.target).toBe('1 recipient · via mock · sender asked to send anyway, recheck found no flag');
  });

  it('send: approved recipients marked Needs approval are on the record (D85)', () => {
    const e = toAuditEvent(
      row('send', { recipients: 2, provider: 'mock', recipientOverride: true }),
      'Project Sparrow',
    );
    expect(e.action).toBe('Sent an outbound message');
    expect(e.target).toBe('2 recipients · via mock · sender approved recipients marked Needs approval');
  });

  it('screen: a reputational hold returns to the sender, never the queue', () => {
    const e = toAuditEvent(
      row('screen', { verdict: 'hold', holdCause: 'reputational', llmChecked: true }),
      'Project Sparrow',
    );
    // Decision 2 (#158): a reputational soft hold is the sender's call — it
    // never enters the supervisory queue, so the evidence must not say so.
    expect(e.target).toBe('Held (reputational risk), returned to sender · AI-checked');
  });

  it('screen: blocked returns to the sender; a rewrite is never asserted', () => {
    const e = toAuditEvent(
      row('screen', { verdict: 'blocked', llmChecked: true }),
      'Project Sparrow',
    );
    expect(e.target).toBe('Blocked, returned to sender · AI-checked');
  });

  it('screen: a rules-decided block never claims an AI check', () => {
    const e = toAuditEvent(
      row('screen', { verdict: 'blocked', llmChecked: false }),
      'Project Sparrow',
    );
    expect(e.target).toBe('Blocked, returned to sender · rules-decided');
  });

  it('screen: an honored send-as-is is part of the screen row itself', () => {
    const e = toAuditEvent(
      row('screen', {
        verdict: 'hold',
        holdCause: 'reputational',
        sentAsIs: true,
        llmChecked: true,
      }),
      'Project Sparrow',
    );
    // The message SENT: "returned to sender" here would contradict the send
    // row immediately after it.
    expect(e.target).toBe('Flagged at screening (reputational risk), sent anyway · AI-checked');

    // Legacy rows carry the pre-#192 'override' key — same truth, same label.
    const legacy = toAuditEvent(
      row('screen', {
        verdict: 'hold',
        holdCause: 'reputational',
        override: 'reputational',
        llmChecked: true,
      }),
      'Project Sparrow',
    );
    expect(legacy.target).toBe('Flagged at screening (reputational risk), sent anyway · AI-checked');

    // #192: an MNPI read sent as-is reads as the sender's audited choice.
    const mnpi = toAuditEvent(
      row('screen', { verdict: 'hold', holdCause: 'mnpi', sentAsIs: true, llmChecked: false }),
      'Project Sparrow',
    );
    expect(mnpi.target).toBe('Flagged at screening (MNPI), sent anyway · not AI-checked');
  });

  it('screen: an unrecognized hold cause is printed as written, never as MNPI', () => {
    const e = toAuditEvent(
      row('screen', { verdict: 'hold', holdCause: 'conflict', llmChecked: true }),
      'Project Sparrow',
    );
    expect(e.target).toBe('Held (conflict), sent to supervisory review · AI-checked');
  });

  it('screen: a row without a mail-shaped detail keeps the raw label (legacy rows)', () => {
    const noVerdict = toAuditEvent(
      row('screen', { mode: undefined, step: 'COMPLIANCE_SCREEN' }),
      'Project Sparrow',
    );
    // Legacy spine rows are not mail evidence — dressing them in the mail
    // vocabulary would fabricate a screen that never ran.
    expect(noVerdict.action).toBe('screen');
    expect(noVerdict.target).toBe('');

    // A spine COMPLIANCE_VERDICT detail can carry a mail-identical `verdict`;
    // only the mail writers' `mode` field admits a row to the mail vocabulary.
    const spineWithVerdict = toAuditEvent(
      row('screen', { mode: undefined, verdict: 'hold', step: 'COMPLIANCE_SCREEN' }),
      'Project Sparrow',
    );
    expect(spineWithVerdict.action).toBe('screen');
    expect(spineWithVerdict.target).toBe('');
  });

  it('send: recipients, provider, and the reviewer release are all visible', () => {
    const e = toAuditEvent(
      row('send', { recipients: 1, provider: 'resend', released: true }),
      'Project Sparrow',
    );
    expect(e.action).toBe('Sent an outbound message');
    expect(e.target).toBe('1 recipient · via resend · released by reviewer');
  });

  it('send: a legacy front-page override reads as the same send-as-is truth', () => {
    const e = toAuditEvent(
      row('send', { recipients: 2, provider: 'resend', override: 'reputational' }),
      'Project Sparrow',
    );
    expect(e.action).toBe('Sent despite a compliance flag');
    expect(e.target).toBe('2 recipients · via resend · flagged for reputational risk');
  });

  it('release and reject read as supervisory review, note first', () => {
    const rel = toAuditEvent(row('release', { note: 'Reviewed, fine to send.' }), 'P');
    expect(rel.action).toBe('Released from supervisory review');
    expect(rel.target).toBe('Reviewed, fine to send.');

    const rej = toAuditEvent(row('reject', {}), 'P');
    expect(rej.action).toBe('Rejected in supervisory review');
    expect(rej.target).toBe('Returned to the sender');
  });

  it('create of the mandate names the codename only, never the deal code', () => {
    const e = toAuditEvent(
      row('create', { codename: 'Project Ember', code: 'EMBER-2026-152' }),
      'Project Ember',
    );
    expect(e.action).toBe('Created the mandate');
    expect(e.target).toBe('Project Ember');
  });

  it('create + agent_run reads as who launched an Ignatious skill', () => {
    const e = toAuditEvent(
      row('create', {
        kind: 'agent_run',
        agent: 'md-briefing',
        depth: 'one_pager',
        executionId: 'ex_1',
      }),
      'Project Sparrow',
    );
    expect(e.action).toBe('Ran an Ignatious skill');
    expect(e.target).toBe('md-briefing · one_pager · ex_1');
    expect(e.person).toBe('Alex Chen');
    expect(e.detail).toBeUndefined();
  });
});

describe('audit trail — Book field updates', () => {
  const update = (detail: Record<string, unknown>): ServerAuditRow => ({
    id: 'u1',
    ts: '2026-08-31T21:00:00Z',
    action: 'update',
    document_id: null,
    detail,
    actor: { id: 'u1', full_name: 'Charles Willian', display_name: null },
  });

  it('names the field and both values for a fee change', () => {
    const e = toAuditEvent(
      update({ field: 'fee_usd', from: 1250000, to: 1500000 }),
      'Project Sparrow',
    );
    expect(e.action).toBe('Updated the Book record');
    expect(e.target).toBe('Fee · $1,250,000 → $1,500,000');
  });

  it('reads a first-time close date as set from empty', () => {
    const e = toAuditEvent(
      update({ field: 'target_close_date', from: null, to: '2026-12-15' }),
      'Project Sparrow',
    );
    expect(e.target).toBe('Target close date · Not set → Dec 15, 2026');
  });

  it('humanizes enum values and marks an unchanged write', () => {
    const e = toAuditEvent(
      update({ field: 'schedule_status', from: 'on_track', to: 'on_track' }),
      'Project Sparrow',
    );
    expect(e.target).toBe('Schedule status · On track (unchanged)');
  });

  it('withdrawing a nullable field reads as cleared', () => {
    const e = toAuditEvent(
      update({ field: 'schedule_status', from: 'at_risk', to: null }),
      'Project Sparrow',
    );
    expect(e.target).toBe('Schedule status · At risk → Not set');
  });

  it('falls back to the raw action when the row carries no field', () => {
    const e = toAuditEvent(update({}), 'Project Sparrow');
    expect(e.action).toBe('update');
  });
});

describe('audit trail — Person column', () => {
  const at = (actor: ServerAuditRow['actor']): ServerAuditRow => ({
    id: 'p1',
    ts: '2026-10-22T12:00:00Z',
    action: 'advance',
    document_id: null,
    detail: { from: 3, to: 4 },
    actor,
  });

  it('names the user, preferring the display name, with no "by" detail', () => {
    const e = toAuditEvent(
      at({ id: 'u1', full_name: 'Storm Duncan', display_name: 'Storm' }),
      'Project Sparrow',
    );
    expect(e.person).toBe('Storm');
    expect(e.personId).toBe('u1');
    expect(e.detail).toBeUndefined();

    const embedded = toAuditEvent(
      at([{ id: 'u2', full_name: 'Morgan Lee', display_name: null }]),
      'Project Sparrow',
    );
    expect(embedded.person).toBe('Morgan Lee');
  });

  it('a row with no user (service or model) reads Conductia', () => {
    expect(toAuditEvent(at(null), 'Project Sparrow').person).toBe('Conductia');
    expect(toAuditEvent(at(null), 'Project Sparrow').personId).toBeUndefined();
    expect(toAuditEvent(at([]), 'Project Sparrow').person).toBe('Conductia');
  });

  it('a user with no name on file is still a person, never Conductia', () => {
    const e = toAuditEvent(
      at({ id: 'u3', full_name: null, display_name: null }),
      'Project Sparrow',
    );
    expect(e.person).toBe('Someone');
  });
});

describe('audit trail — step actions and the second compliance check', () => {
  const stepRow = (action: string, detail: Record<string, unknown>): ServerAuditRow => ({
    id: 's1',
    ts: '2026-10-22T12:00:00Z',
    action,
    document_id: null,
    detail,
    actor: { id: 'u1', full_name: 'Storm Duncan', display_name: null },
  });

  it('assign and complete name the step by its title, never the assignee id', () => {
    const assigned = toAuditEvent(
      stepRow('assign_step', {
        stepId: 'p1-s13',
        assignee: '438ea90e-e2b7-4730-b463-d805e73e86de',
        stepTitle: 'Initial Diligence Request List',
      }),
      'Project Granite',
    );
    expect(assigned.action).toBe('Assigned a step');
    expect(assigned.target).toBe('Initial Diligence Request List');
    expect(assigned.target).not.toContain('438ea90e');

    const completed = toAuditEvent(
      stepRow('complete_step', { seq: 10, stepId: 'p1-s10', stepTitle: 'Meeting Intelligence' }),
      'Project Granite',
    );
    expect(completed.action).toBe('Completed a step');
    expect(completed.target).toBe('Meeting Intelligence');
  });

  it('saved work names the step from the rail catalog, or "Step" when unknown', () => {
    const known = toAuditEvent(
      stepRow('step_work', { stepId: 'p1-s10', fields: ['ai_consent'] }),
      'Project Granite',
    );
    expect(known.action).toBe('Saved work on a step');
    expect(known.target).not.toBe('');
    expect(known.target).not.toBe('p1-s10');

    const unknown = toAuditEvent(stepRow('step_work', { stepId: 'custom-x', fields: [] }), 'P');
    expect(unknown.target).toBe('Step');
  });

  it('the model second check states only its recorded outcome', () => {
    const row: ServerAuditRow = {
      id: 'm1',
      ts: '2026-10-22T12:00:00Z',
      action: 'screen',
      document_id: null,
      detail: { mode: 'second_opinion', model: 'claude-haiku-4-5', outcome: 'escalated' },
      actor: null,
    };
    const e = toAuditEvent(row, 'Project Granite');
    expect(e.action).toBe('Second compliance check recorded');
    expect(e.target).toBe('Escalated');
    expect(e.person).toBe('Conductia');

    const bare = toAuditEvent({ ...row, detail: { mode: 'second_opinion' } }, 'P');
    expect(bare.action).toBe('Second compliance check recorded');
    expect(bare.target).toBe('');
  });
});
