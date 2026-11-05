import { describe, it, expect } from 'vitest';

import {
  addInvite,
  applyCreateResult,
  applyResendResult,
  INVITE_DEAL_ROLES,
  markCreating,
  removeInvite,
  retryActionFor,
  summarizeInviteOutcomes,
  type InviteChip,
} from '../src/components/wizard/inviteQueue';
import { DEAL_ROLE } from '../src/lib/constants/roles';

/*
 * Gate 0 invite queue — the pure chip state machine behind the Team step's
 * "Invite by email" affordance. Chips queue before the deal exists and fire
 * after create; these tests cover every transition without mounting the
 * wizard, including the 201-with-deliveryStatus-'unsent' and 409-with-inviteId
 * branches.
 */

function chip(overrides: Partial<InviteChip> = {}): InviteChip {
  return {
    email: 'jordan@bank.com',
    role: DEAL_ROLE.DEAL_TEAM,
    state: 'queued',
    ...overrides,
  };
}

describe('invite deal roles', () => {
  it('offers internal seats only (deal_team, legal, read_only)', () => {
    expect(INVITE_DEAL_ROLES).toEqual([
      DEAL_ROLE.DEAL_TEAM,
      DEAL_ROLE.LEGAL,
      DEAL_ROLE.READ_ONLY,
    ]);
  });
});

describe('addInvite', () => {
  it('queues a normalized chip (trimmed, lowercased)', () => {
    const result = addInvite([], '  Jordan@Bank.com ', DEAL_ROLE.LEGAL);
    expect(result).toEqual({
      ok: true,
      queue: [{ email: 'jordan@bank.com', role: DEAL_ROLE.LEGAL, state: 'queued' }],
    });
  });

  it('rejects a malformed email', () => {
    const result = addInvite([], 'not-an-email', DEAL_ROLE.DEAL_TEAM);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/valid email/i);
  });

  it('rejects a duplicate already in the queue, case-insensitively', () => {
    const first = addInvite([], 'jordan@bank.com', DEAL_ROLE.DEAL_TEAM);
    if (!first.ok) throw new Error('setup add failed');
    const dup = addInvite(first.queue, 'JORDAN@bank.com', DEAL_ROLE.LEGAL);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toMatch(/already queued/i);
    // The original chip is untouched.
    expect(first.queue).toHaveLength(1);
  });
});

describe('removeInvite', () => {
  it('removes a queued chip', () => {
    expect(removeInvite([chip()], 'jordan@bank.com')).toEqual([]);
  });

  it('never removes a chip whose create already fired', () => {
    const fired = chip({ state: 'sent', inviteId: 'inv-1' });
    expect(removeInvite([fired], 'jordan@bank.com')).toEqual([fired]);
  });
});

describe('markCreating', () => {
  it('marks only the matching chip in flight and clears its error', () => {
    const other = chip({ email: 'sam@bank.com' });
    const queue = markCreating(
      [chip({ error: 'stale' }), other],
      'jordan@bank.com',
    );
    expect(queue[0]).toEqual(chip({ state: 'creating', error: undefined }));
    expect(queue[1]).toEqual(other);
  });
});

describe('applyCreateResult', () => {
  const inFlight = chip({ state: 'creating' });

  it('201 with deliveryStatus sent lands the chip on sent', () => {
    const queue = applyCreateResult([inFlight], 'jordan@bank.com', {
      kind: 'created',
      inviteId: 'inv-1',
      deliveryStatus: 'sent',
    });
    expect(queue[0].state).toBe('sent');
    expect(queue[0].inviteId).toBe('inv-1');
  });

  it('201 with deliveryStatus unsent lands on created-email-failed with the invite id', () => {
    const queue = applyCreateResult([inFlight], 'jordan@bank.com', {
      kind: 'created',
      inviteId: 'inv-2',
      deliveryStatus: 'unsent',
    });
    expect(queue[0].state).toBe('created-email-failed');
    expect(queue[0].inviteId).toBe('inv-2');
  });

  it('200 for an existing account records access granted without a delivery retry', () => {
    const queue = applyCreateResult([inFlight], 'jordan@bank.com', {
      kind: 'existing',
      accessGranted: true,
    });
    expect(queue[0].state).toBe('access-granted');
    expect(queue[0].inviteId).toBeUndefined();
    expect(retryActionFor(queue[0])).toEqual({ type: 'none' });
  });

  it('409 duplicate WITH inviteId is treated as created; resend is the retry', () => {
    const queue = applyCreateResult([inFlight], 'jordan@bank.com', {
      kind: 'duplicate',
      inviteId: 'inv-3',
    });
    expect(queue[0].state).toBe('created-email-failed');
    expect(queue[0].inviteId).toBe('inv-3');
    expect(retryActionFor(queue[0])).toEqual({ type: 'resend', inviteId: 'inv-3' });
  });

  it('409 duplicate WITHOUT inviteId stays a plain failure (nothing to resend)', () => {
    const queue = applyCreateResult([inFlight], 'jordan@bank.com', {
      kind: 'duplicate',
    });
    expect(queue[0].state).toBe('failed');
    expect(queue[0].inviteId).toBeUndefined();
    expect(queue[0].error).toMatch(/already pending/i);
  });

  it('network or 5xx lands on failed, carrying the server message when given', () => {
    const queue = applyCreateResult([inFlight], 'jordan@bank.com', {
      kind: 'error',
      message: 'Forbidden',
    });
    expect(queue[0].state).toBe('failed');
    expect(queue[0].error).toBe('Forbidden');
  });

  it('touches only the matching chip', () => {
    const other = chip({ email: 'sam@bank.com', state: 'queued' });
    const queue = applyCreateResult([inFlight, other], 'jordan@bank.com', {
      kind: 'created',
      inviteId: 'inv-1',
      deliveryStatus: 'sent',
    });
    expect(queue[1]).toEqual(other);
  });
});

describe('applyResendResult', () => {
  const emailFailed = chip({ state: 'created-email-failed', inviteId: 'inv-1' });

  it('a successful resend lands the chip on sent', () => {
    const queue = applyResendResult([emailFailed], 'jordan@bank.com', {
      ok: true,
      deliveryStatus: 'sent',
    });
    expect(queue[0].state).toBe('sent');
  });

  it('a resend that still could not deliver stays created-email-failed', () => {
    const queue = applyResendResult([emailFailed], 'jordan@bank.com', {
      ok: true,
      deliveryStatus: 'unsent',
    });
    expect(queue[0].state).toBe('created-email-failed');
  });

  it('a failed resend request stays created-email-failed (resend remains the retry)', () => {
    const queue = applyResendResult([emailFailed], 'jordan@bank.com', { ok: false });
    expect(queue[0].state).toBe('created-email-failed');
    expect(retryActionFor(queue[0])).toEqual({ type: 'resend', inviteId: 'inv-1' });
  });
});

describe('retryActionFor', () => {
  it('failed retries by re-POSTing the create (the server dedupes)', () => {
    expect(retryActionFor(chip({ state: 'failed' }))).toEqual({ type: 'create' });
  });

  it('created-email-failed without an invite id has no retry', () => {
    expect(retryActionFor(chip({ state: 'created-email-failed' }))).toEqual({
      type: 'none',
    });
  });

  it('queued, creating, and sent have no retry', () => {
    expect(retryActionFor(chip({ state: 'queued' }))).toEqual({ type: 'none' });
    expect(retryActionFor(chip({ state: 'creating' }))).toEqual({ type: 'none' });
    expect(retryActionFor(chip({ state: 'sent', inviteId: 'inv-1' }))).toEqual({
      type: 'none',
    });
  });
});

describe('summarizeInviteOutcomes', () => {
  it('is null when nothing was queued', () => {
    expect(summarizeInviteOutcomes([])).toBeNull();
  });

  it('reports all-sent with correct pluralization', () => {
    expect(summarizeInviteOutcomes([{ state: 'sent' }])).toBe('1 invitation sent.');
    expect(summarizeInviteOutcomes([{ state: 'sent' }, { state: 'sent' }])).toBe(
      '2 invitations sent.',
    );
  });

  it('reports mixed outcomes honestly and points at Team', () => {
    expect(
      summarizeInviteOutcomes([
        { state: 'sent' },
        { state: 'sent' },
        { state: 'created-email-failed' },
      ]),
    ).toBe("2 invitations sent, 1 failed. Retry from the deal's Team.");
  });

  it('does not report direct access as an invitation delivery', () => {
    expect(summarizeInviteOutcomes([{ state: 'access-granted' }])).toBeNull();
    expect(
      summarizeInviteOutcomes([{ state: 'access-granted' }, { state: 'sent' }]),
    ).toBe('1 invitation sent.');
  });

  it('distinguishes a newly granted seat from an existing seat', () => {
    const [existingSeat] = applyCreateResult(
      [{ email: 'member@bank.dev', role: DEAL_ROLE.DEAL_TEAM, state: 'creating' }],
      'member@bank.dev',
      { kind: 'existing', accessGranted: false },
    );
    expect(existingSeat.state).toBe('access-existing');
    expect(summarizeInviteOutcomes([existingSeat])).toBeNull();
  });
});
