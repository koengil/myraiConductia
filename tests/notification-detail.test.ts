import { describe, expect, it } from 'vitest';

import { TEAM_MAILBOX_CHECK_REASONS } from '@/lib/constants/discovery';
import { NOTIFICATION_EVENT } from '@/lib/constants/notifications';
import { notificationDetail, TEAM_REFUSAL_SHORT } from '@/lib/notifications/notificationDetail';
import type { AppNotification } from '@/lib/notifications/useNotifications';

// #173 G-04: the bell's second line. A team refusal names the inbox and a short reason, drift reads its counts,
// and every other kind keeps the chain the bell used before.

function note(event_type: string, payload: Record<string, unknown>): AppNotification {
  return {
    id: 'n1',
    deal_id: null,
    event_type,
    payload: payload as AppNotification['payload'],
    read_at: null,
    created_at: '2026-10-22T09:00:00.000Z',
  };
}

const refused = (payload: Record<string, unknown>) => note(NOTIFICATION_EVENT.TEAM_MAILBOX_REFUSED, payload);
const drift = (payload: Record<string, unknown>) => note(NOTIFICATION_EVENT.MAILBOX_ALLOWLIST_DRIFT, payload);

describe('notificationDetail: team inbox refusal', () => {
  it('has one short phrase per check reason, and no other', () => {
    expect(Object.keys(TEAM_REFUSAL_SHORT).sort()).toEqual([...TEAM_MAILBOX_CHECK_REASONS].sort());
  });

  it.each(TEAM_MAILBOX_CHECK_REASONS)('reads "address · short reason" for %s', (reason) => {
    const line = notificationDetail(refused({ teamMailboxId: 'tm-1', address: 'deals@bank.example', reason, href: '/discovery' }));
    expect(line).toBe(`deals@bank.example · ${TEAM_REFUSAL_SHORT[reason]}`);
    expect(TEAM_REFUSAL_SHORT[reason].length).toBeGreaterThan(0);
    expect(line).not.toMatch(/—/);
    expect(line).not.toMatch(/a deal/);
  });

  it('gives the design phrases', () => {
    expect(TEAM_REFUSAL_SHORT).toEqual({
      group: 'Google Group, not a mailbox',
      alias: 'Alias, not the primary address',
      suspended: 'Account suspended',
      no_mailbox: 'No mailbox yet',
      not_found: 'Not found in Workspace',
      identity_changed: 'Address moved to another account',
      directory_denied: 'Directory read not granted',
    });
  });

  it('keeps what it has when a part is missing', () => {
    expect(notificationDetail(refused({ address: 'deals@bank.example', reason: 'banana' }))).toBe('deals@bank.example');
    expect(notificationDetail(refused({ address: 'deals@bank.example' }))).toBe('deals@bank.example');
    expect(notificationDetail(refused({ reason: 'directory_denied' }))).toBe('Directory read not granted');
    expect(notificationDetail(refused({}))).toBe('A team inbox');
    expect(notificationDetail(refused({ address: '', reason: 7 }))).toBe('A team inbox');
  });
});

describe('notificationDetail: allowlist drift', () => {
  it('says the provider group could not be read', () => {
    expect(notificationDetail(drift({ provider: 'google', status: 'unavailable', missingCount: 0, extraCount: 0 }))).toBe(
      'Provider group could not be read',
    );
  });

  it('reads the counts of a drift', () => {
    expect(notificationDetail(drift({ provider: 'google', status: 'drift', missingCount: 1, extraCount: 0 }))).toBe(
      '1 missing, 0 extra',
    );
    expect(notificationDetail(drift({ provider: 'microsoft', status: 'drift', missingCount: 2, extraCount: 3 }))).toBe(
      '2 missing, 3 extra',
    );
  });

  it('never reads "a deal", and treats a count it cannot read as 0', () => {
    expect(notificationDetail(drift({ status: 'drift' }))).toBe('0 missing, 0 extra');
    expect(notificationDetail(drift({ status: 'drift', missingCount: -1, extraCount: 'x' }))).toBe('0 missing, 0 extra');
  });
});

describe('notificationDetail: every other kind keeps the chain the bell uses', () => {
  it('prefers the destination label, then the code name and the address, never the code', () => {
    const all = { destinationLabel: 'Leads', code: 'FALCO-2026-123', codename: 'Project Falcon', address: 'a@bank.example' };
    expect(notificationDetail(note('access_requested', all))).toBe('Leads');
    expect(notificationDetail(note('deal_created', { ...all, destinationLabel: undefined }))).toBe('Project Falcon');
    expect(notificationDetail(note('deal_created', { codename: 'Project Falcon', address: 'a@bank.example' }))).toBe(
      'Project Falcon',
    );
    expect(notificationDetail(note('mailbox_connected', { address: 'storm.duncan@bank.example', outcome: 'created' }))).toBe(
      'storm.duncan@bank.example',
    );
  });

  it('ignores a destination label that is not text', () => {
    expect(notificationDetail(note('deal_created', { destinationLabel: 3, codename: 'Project Heron', code: 'HERON-2026-004' }))).toBe(
      'Project Heron',
    );
  });

  it('falls back to "a deal"', () => {
    expect(notificationDetail(note('work_identity_replaced', {}))).toBe('a deal');
  });
});
