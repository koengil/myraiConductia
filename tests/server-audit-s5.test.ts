import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_ACTION } from '../src/lib/constants/audit';
import { fetchServerAudit, toAuditEvent, type ServerAuditRow } from '../src/lib/audit/serverAudit';
import type { AuditEvent } from '../src/lib/audit/store';

/*
 * The server audit projection:
 *   - a failed read is null, a non-member's 404 is 'not-on-deal', never [].
 *   - every server row carries its raw detail payload for the export.
 *   - US dates, role labels and step names, never ISO dates, raw roles or seqs.
 *   - the invite override and challenge rows read in words.
 */

const row = (action: string, detail: Record<string, unknown> | null): ServerAuditRow => ({
  id: 'a1',
  ts: '2026-10-23T12:00:00Z',
  action,
  document_id: null,
  detail,
  actor: { id: 'u1', full_name: 'Pat Rivera', display_name: null },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchServerAudit', () => {
  const respond = (status: number, body: unknown = {}) =>
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: status < 300, status, json: async () => body }) as Response));

  it('a 500 is a failure, null', async () => {
    respond(500);
    expect(await fetchServerAudit('ZZ-A')).toBeNull();
  });

  it('a network error is a failure, null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await fetchServerAudit('ZZ-A')).toBeNull();
  });

  it('a 404 (the route\'s answer to a non-member) is a refusal, never an empty trail', async () => {
    respond(404);
    expect(await fetchServerAudit('ZZ-A')).toBe('not-on-deal');
  });

  it('a 403 (an account gate such as MFA) is a failed read, null', async () => {
    respond(403);
    expect(await fetchServerAudit('ZZ-A')).toBeNull();
  });

  it('maps the rows and carries each raw detail', async () => {
    const detail = { recipients: 1, recipientReview: { recipients: [{ email: 'ext1@outside.test' }] } };
    respond(200, { deal: { id: 'd', code: 'ZZ-A', codename: 'Project Z' }, events: [row('send', detail)] });
    const [event] = (await fetchServerAudit('ZZ-A')) as AuditEvent[];
    expect(event.serverDetail).toEqual(detail);
    expect(event.actionKey).toBe('send');
  });
});

describe('dates, roles and steps in words', () => {
  it('formats the target close date as a US date', () => {
    const e = toAuditEvent(row('update', { field: 'target_close_date', from: null, to: '2027-03-26' }), 'Project Z');
    expect(e.target).toBe('Target close date · Not set → Mar 26, 2027');
  });

  it('an unset Book value reads "Not set", as the Book itself does', () => {
    const e = toAuditEvent(row('update', { field: 'schedule_status', from: null, to: 'on_time' }), 'Project Z');
    expect(e.target).toBe('Schedule status · Not set → On time');
  });

  it('formats the conflicts approval date as a US date', () => {
    const e = toAuditEvent(row('attest', { approved_by: 'Pat Rivera', approved_on: '2026-10-23' }), 'Project Z');
    expect(e.target).toBe('Approved by Pat Rivera on Oct 23, 2026');
  });

  it.each([
    ['grant', 'Granted deal access'],
    ['revoke', 'Revoked deal access'],
  ])('%s names the seat by its role label, never the raw role', (action, label) => {
    const e = toAuditEvent(row(action, { deal_role: 'md' }), 'Project Z');
    expect(e.action).toBe(label);
    expect(e.target).toBe('Seat · Managing Director');
    expect(e.target).not.toMatch(/Seat · md/);
  });

  it('a seq-only advance names both steps from the catalogue', () => {
    const e = toAuditEvent(row('advance', { from: 9, to: 10 }), 'Project Z');
    expect(e.target).toBe('MD Briefing + Company Backgrounding → Meeting Intelligence');
    expect(e.target).not.toMatch(/Step 9 → 10/);
  });

  it('an advance with step keys names them by title, not by seq', () => {
    const e = toAuditEvent(
      row('advance', { from: 9, to: 10, fromStepKey: 'p1-s9', toStepKey: 'p1-s10', fromTitle: null, toTitle: null }),
      'Project Z',
    );
    expect(e.target).toBe('MD Briefing + Company Backgrounding → Meeting Intelligence');
  });

  it('an unknown step with no title still falls back to its number', () => {
    const e = toAuditEvent(row('advance', { from: 11, to: 12, fromStepKey: 'p2-s11', toStepKey: 'p2-s12' }), 'Project Z');
    expect(e.target).toBe('Step 11 → 12');
  });
});

describe('invite audit rows in words', () => {
  it('names the domain override and targets the invitee', () => {
    const e = toAuditEvent(
      row(AUDIT_ACTION.INVITE_DOMAIN_OVERRIDE, {
        invite_id: 'i1',
        email: 'new@tidewater.test',
        classification: 'unverified',
        outcome: 'confirmed',
      }),
      'Project Z',
    );
    expect(e.action).toBe('Confirmed an unverified email domain for an invitation');
    expect(e.target).toBe('new@tidewater.test');
    expect(e.actionKey).toBe('invite_domain_override');
  });

  it.each([
    [AUDIT_ACTION.INVITE_CHALLENGE_ISSUED, 'Issued an invitation challenge'],
    [AUDIT_ACTION.INVITE_CHALLENGE_ROTATED, 'Rotated an invitation challenge'],
  ])('%s reads %s', (action, label) => {
    const e = toAuditEvent(row(action, { invite_id: 'i1', challenge_version: 2, outcome: 'issued' }), 'Project Z');
    expect(e.action).toBe(label);
    expect(e.target).toBe('Invitation');
    expect(`${e.action} ${e.target}`).not.toMatch(/invite_/);
  });
});
