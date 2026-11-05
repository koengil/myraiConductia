// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { DIRECTORY_SCOPES } from '@/lib/constants/googleReader';
import { createGoogleTeamMailboxVerifier, TEAM_MAILBOX_CHECK_HTTP } from '@/lib/google/reader/directoryUser';
import type { GoogleRegistration } from '@/lib/google/reader/registration';

import { scripted, type Reply } from './helpers';

// The Google Directory check of a team inbox address (#581, design R7): a real, active user mailbox is verified;
// everything definitive is refused with a fixed reason; everything else is a transient error that never changes a
// status. The Directory is scripted: nothing here reaches Google.

const TENANT = '11111111-1111-4111-8111-111111111111';
const ADDRESS = 'deals@bank.example';
const REGISTRATION: GoogleRegistration = {
  tenantId: TENANT,
  workspaceDomain: 'bank.example',
  serviceAccountEmail: 'dwd-reader@proj-1.iam.gserviceaccount.com',
  clientId: '123456789012345678',
  directoryServiceAccountEmail: 'dir-reader@proj-1.iam.gserviceaccount.com',
  allowlistGroup: 'conductia-ingest@bank.example',
  firmCompanyId: null,
};
const registry = { registrationFor: async () => REGISTRATION };
const NO_SLEEP = { sleep: async () => undefined, random: () => 0.5 };

const USER = { id: 'user-1', primaryEmail: ADDRESS, suspended: false, archived: false, isMailboxSetup: true };
const NOT_FOUND: Reply = { status: 404, body: { error: { errors: [{ reason: 'notFound' }] } } };
const FORBIDDEN: Reply = { status: 403, body: { error: { errors: [{ reason: 'forbidden' }] } } };

function verifierWith(replies: Reply[]) {
  const { fetchImpl, calls } = scripted(replies);
  const verifier = createGoogleTeamMailboxVerifier({
    callerToken: async () => 'caller-token',
    directoryToken: async () => 'dir-token',
    registry,
    fetchImpl,
    http: NO_SLEEP,
  });
  return { verifier, calls };
}

const userCall = `/users/${encodeURIComponent(ADDRESS)}`;
const groupCall = `/groups/${encodeURIComponent(ADDRESS)}/members`;

describe('a user mailbox is verified', () => {
  it('answers verified with the Directory id for an active user whose primary address is the address', async () => {
    const { verifier, calls } = verifierWith([{ status: 200, body: USER }]);
    expect(await verifier.verify(TENANT, ADDRESS, null)).toEqual({ status: 'verified', directoryUserId: 'user-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`https://admin.googleapis.com/admin/directory/v1${userCall}?`);
    // Only what the verdict needs is asked for: no name, phone or organisation.
    expect(new URL(calls[0].url).searchParams.get('fields')).toBe('id,primaryEmail,suspended,archived,isMailboxSetup');
    expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer dir-token');
  });

  it('compares the primary address without regard to case, and normalises the address it is given', async () => {
    const { verifier, calls } = verifierWith([{ status: 200, body: { ...USER, primaryEmail: 'Deals@Bank.Example' } }]);
    expect(await verifier.verify(TENANT, ' Deals@Bank.Example ', null)).toEqual({ status: 'verified', directoryUserId: 'user-1' });
    expect(calls[0].url).toContain(userCall);
  });

  it('keeps the pinned account: the same id verifies', async () => {
    const { verifier } = verifierWith([{ status: 200, body: USER }]);
    expect(await verifier.verify(TENANT, ADDRESS, 'user-1')).toEqual({ status: 'verified', directoryUserId: 'user-1' });
  });
});

describe('a definitive answer refuses with a fixed reason', () => {
  it('refuses an alias: the Directory answers with the account and its other primary address', async () => {
    const { verifier } = verifierWith([{ status: 200, body: { ...USER, primaryEmail: 'sales@bank.example' } }]);
    expect(await verifier.verify(TENANT, ADDRESS, null)).toEqual({ status: 'refused', reason: 'alias' });
  });

  it.each([
    ['suspended', { suspended: true }],
    ['archived', { archived: true }],
  ])('refuses a %s account as suspended', async (_name, patch) => {
    const { verifier } = verifierWith([{ status: 200, body: { ...USER, ...patch } }]);
    expect(await verifier.verify(TENANT, ADDRESS, null)).toEqual({ status: 'refused', reason: 'suspended' });
  });

  it.each([
    ['set up false', { isMailboxSetup: false }],
    ['absent (Google may omit a false boolean)', { isMailboxSetup: undefined }],
  ])('refuses an account whose mailbox is %s as no_mailbox', async (_name, patch) => {
    const { verifier } = verifierWith([{ status: 200, body: { ...USER, ...patch } }]);
    expect(await verifier.verify(TENANT, ADDRESS, null)).toEqual({ status: 'refused', reason: 'no_mailbox' });
  });

  it('refuses an address that now belongs to another account than the pinned one', async () => {
    const { verifier } = verifierWith([{ status: 200, body: USER }]);
    expect(await verifier.verify(TENANT, ADDRESS, 'user-0')).toEqual({ status: 'refused', reason: 'identity_changed' });
  });

  it('refuses a Google Group: no user, but the address answers as a group', async () => {
    const { verifier, calls } = verifierWith([NOT_FOUND, { status: 200, body: { kind: 'admin#directory#members' } }]);
    expect(await verifier.verify(TENANT, ADDRESS, null)).toEqual({ status: 'refused', reason: 'group' });
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain(`https://admin.googleapis.com/admin/directory/v1${groupCall}?`);
    // One member at most, and only the kind: whether the group exists, not who is in it.
    expect(new URL(calls[1].url).searchParams.get('maxResults')).toBe('1');
    expect(new URL(calls[1].url).searchParams.get('fields')).toBe('kind');
    expect(new Headers(calls[1].init.headers).get('Authorization')).toBe('Bearer dir-token');
  });

  it('refuses an address that is neither a user nor a group as not_found', async () => {
    const { verifier } = verifierWith([NOT_FOUND, NOT_FOUND]);
    expect(await verifier.verify(TENANT, ADDRESS, null)).toEqual({ status: 'refused', reason: 'not_found' });
  });

  it('refuses a group the directory role may not read as directory_denied, not as not_found', async () => {
    const { verifier } = verifierWith([NOT_FOUND, FORBIDDEN]);
    expect(await verifier.verify(TENANT, ADDRESS, null)).toEqual({ status: 'refused', reason: 'directory_denied' });
  });

  it('refuses when the directory role may not read users at all, without asking about a group', async () => {
    const { verifier, calls } = verifierWith([FORBIDDEN]);
    expect(await verifier.verify(TENANT, ADDRESS, null)).toEqual({ status: 'refused', reason: 'directory_denied' });
    expect(calls).toHaveLength(1);
  });
});

describe('anything else is a transient error, never a refusal', () => {
  it('treats a 5xx, after its retries, as a directory error', async () => {
    const down: Reply = { status: 500, body: { error: { message: 'Subject: Project Falcon' } } };
    const { verifier, calls } = verifierWith([down, down, down]);
    const result = await verifier.verify(TENANT, ADDRESS, null);
    expect(result).toEqual({ status: 'error', reason: 'directory_error' });
    expect(calls).toHaveLength(TEAM_MAILBOX_CHECK_HTTP.maxAttempts);
    expect(JSON.stringify(result)).not.toContain('Falcon');
  });

  it('treats a throttle as a directory error, not as the role saying no', async () => {
    const throttled: Reply = { status: 403, body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } };
    const { verifier, calls } = verifierWith([throttled, throttled, throttled]);
    expect(await verifier.verify(TENANT, ADDRESS, null)).toEqual({ status: 'error', reason: 'directory_error' });
    expect(calls).toHaveLength(TEAM_MAILBOX_CHECK_HTTP.maxAttempts);
  });

  it('treats a request that outlives its deadline as a directory error', async () => {
    const fetchImpl = (async () => {
      throw new DOMException('The operation timed out', 'TimeoutError');
    }) as typeof fetch;
    const verifier = createGoogleTeamMailboxVerifier({
      callerToken: async () => 'caller',
      directoryToken: async () => 'dir-token',
      registry,
      fetchImpl,
      http: NO_SLEEP,
    });
    expect(await verifier.verify(TENANT, ADDRESS, null)).toEqual({ status: 'error', reason: 'directory_error' });
  });

  it('treats a failure of the group lookup that is not a definitive answer as a directory error', async () => {
    const down: Reply = { status: 503 };
    const { verifier } = verifierWith([NOT_FOUND, down, down, down]);
    expect(await verifier.verify(TENANT, ADDRESS, null)).toEqual({ status: 'error', reason: 'directory_error' });
  });

  it('treats a directory token that could not be minted as a directory error, with no request', async () => {
    const { fetchImpl, calls } = scripted([]);
    const verifier = createGoogleTeamMailboxVerifier({
      callerToken: async () => 'caller',
      directoryToken: async () => {
        throw new Error('STS refused for deals@bank.example');
      },
      registry,
      fetchImpl,
      http: NO_SLEEP,
    });
    const result = await verifier.verify(TENANT, ADDRESS, null);
    expect(result).toEqual({ status: 'error', reason: 'directory_error' });
    expect(JSON.stringify(result)).not.toContain('@');
    expect(calls).toHaveLength(0);
  });

  it('treats a tenant with no active registration as a directory error', async () => {
    const { fetchImpl, calls } = scripted([]);
    const verifier = createGoogleTeamMailboxVerifier({
      callerToken: async () => 'caller',
      registry: {
        registrationFor: async () => {
          throw new Error('no active Google registration for this tenant');
        },
      },
      fetchImpl,
      http: NO_SLEEP,
    });
    expect(await verifier.verify(TENANT, ADDRESS, null)).toEqual({ status: 'error', reason: 'directory_error' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['no id', { ...USER, id: undefined }],
    ['an empty id', { ...USER, id: '' }],
    ['no primary address', { ...USER, primaryEmail: undefined }],
  ])('never verifies a 200 with %s', async (_name, body) => {
    const { verifier } = verifierWith([{ status: 200, body }]);
    expect(await verifier.verify(TENANT, ADDRESS, null)).toEqual({ status: 'error', reason: 'directory_error' });
  });
});

describe('the token', () => {
  it('without a directory credential, asks IAM Credentials for a token carrying both directory scopes', async () => {
    const { fetchImpl, calls } = scripted([{ status: 200, body: { accessToken: 'minted-token' } }, { status: 200, body: USER }]);
    const verifier = createGoogleTeamMailboxVerifier({ callerToken: async () => 'caller-token', registry, fetchImpl, http: NO_SLEEP });
    expect(await verifier.verify(TENANT, ADDRESS, null)).toEqual({ status: 'verified', directoryUserId: 'user-1' });
    expect(calls[0].url).toContain('iamcredentials.googleapis.com');
    expect(calls[0].url).toContain(encodeURIComponent(REGISTRATION.directoryServiceAccountEmail));
    expect(JSON.parse(String(calls[0].init.body)).scope).toEqual([...DIRECTORY_SCOPES]);
    // The lookup carries the minted token, never the caller's own.
    expect(new Headers(calls[1].init.headers).get('Authorization')).toBe('Bearer minted-token');
  });

  it('with a directory credential, uses its token as it comes and never calls IAM Credentials', async () => {
    const callerCalls: number[] = [];
    const { fetchImpl, calls } = scripted([{ status: 200, body: USER }]);
    const verifier = createGoogleTeamMailboxVerifier({
      callerToken: async () => {
        callerCalls.push(1);
        return 'caller-token';
      },
      directoryToken: async () => 'impersonated-directory-token',
      registry,
      fetchImpl,
      http: NO_SLEEP,
    });
    await verifier.verify(TENANT, ADDRESS, null);
    expect(callerCalls).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).not.toContain('iamcredentials.googleapis.com');
    expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer impersonated-directory-token');
  });

  it('the directory token carries the members and users scopes and no mail scope', () => {
    expect([...DIRECTORY_SCOPES]).toEqual([
      'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
      'https://www.googleapis.com/auth/admin.directory.user.readonly',
    ]);
  });
});
