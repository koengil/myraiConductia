import { describe, it, expect, afterEach, vi } from 'vitest';

import { preflightInvite } from '@/lib/team/invitePreflight';

function answer(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

const req = { email: 'a@b.dev', companyId: 'c1', companyRole: 'member' };

afterEach(() => vi.unstubAllGlobals());

describe('preflightInvite (#250)', () => {
  it('passes a matching domain through', async () => {
    answer(200, { normalizedEmail: 'a@b.dev', classification: 'match', confirmationRequired: false });
    expect(await preflightInvite(req)).toEqual({ kind: 'clear', normalizedEmail: 'a@b.dev' });
  });

  it('returns a typed confirmation', async () => {
    answer(200, { confirmationRequired: true, confirmationId: 'x', classification: 'personal', expiresAt: 't' });
    expect(await preflightInvite(req)).toMatchObject({ kind: 'confirm', id: 'x', classification: 'personal', expiresAt: 't' });
  });

  it('never reads a malformed confirmation as "no confirmation needed"', async () => {
    for (const body of [
      { confirmationRequired: true, classification: 'personal', expiresAt: 't' },
      { confirmationRequired: true, confirmationId: 'x', classification: 'match', expiresAt: 't' },
      { confirmationRequired: true, confirmationId: 'x', classification: 'personal' },
    ]) {
      answer(200, body);
      expect(await preflightInvite(req)).toEqual({ kind: 'error', status: null, message: null });
    }
  });

  it('carries the server error and status', async () => {
    answer(403, { error: 'Forbidden' });
    expect(await preflightInvite(req)).toEqual({ kind: 'error', status: 403, message: 'Forbidden' });
  });
});
