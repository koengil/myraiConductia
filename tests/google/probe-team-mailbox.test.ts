// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DIRECTORY_SCOPES } from '@/lib/constants/googleReader';

import { teamProbeMain } from '../../scripts/google/probe-team-mailbox';

// The owner's live check of the team inbox design (#581, thread T1), run here against a scripted Google. The run
// prints status codes, Google's machine reasons, counts and yes/no only: never an address, an id, a token or mail.

const DOMAIN = 'bank.example';
const TENANT = '11111111-1111-4111-8111-111111111111';
const DWD_SA = 'dwd-reader@proj-1.iam.gserviceaccount.com';
const DIR_SA = 'dir-reader@proj-1.iam.gserviceaccount.com';
const ALLOWLIST_GROUP = 'conductia-ingest@bank.example';

const ALIAS = 'info@bank.example';
const GROUP = 'ops-group@bank.example';
const SUSPENDED = 'former.employee@bank.example';
const SHARED = 'deals@bank.example';
const ALL_ROLES = ['--alias', ALIAS, '--group', GROUP, '--suspended', SUSPENDED, '--shared', SHARED];
const LOCAL_PARTS = ['info', 'ops-group', 'former.employee', 'deals', 'conductia-ingest', 'dana.k'];

// What each token looks like if it ever reached the output.
const CALLER_TOKEN = 'caller-token-ya29.CALLER-SECRET';
const DIRECTORY_TOKEN = 'ya29.DIRECTORY-SECRET';
const DWD_TOKEN = 'ya29.DWD-SECRET';
const SECRETS = [CALLER_TOKEN, DIRECTORY_TOKEN, DWD_TOKEN, 'ya29', 'SECRET', 'Bearer', 'eyJ', 'jwt-'];

type Request = { url: string; auth: string | null; body: string };
type Options = {
  /** users.get answers 403 for every address (the directory role lacks Users read). */
  usersDenied?: boolean;
  /** A message Google puts in the body of every error it sends: it must never reach the output. */
  quotedMessage?: string;
  /** generateAccessToken answers this status for the directory service account. */
  directoryMintStatus?: number;
  /** How the shared mailbox sits in the ingest group: a direct USER member (default), only inside a nested group, or absent. */
  sharedInGroup?: 'direct' | 'nested' | 'absent';
};

let dir: string;
let registrationPath: string;
let credentialsPath: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'probe-team-'));
  registrationPath = join(dir, 'registration.json');
  credentialsPath = join(dir, 'worker-credentials.json');
  writeFileSync(
    registrationPath,
    JSON.stringify({
      tenantId: TENANT,
      workspaceDomain: DOMAIN,
      serviceAccountEmail: DWD_SA,
      clientId: '123456789012345678',
      directoryServiceAccountEmail: DIR_SA,
      allowlistGroup: ALLOWLIST_GROUP,
    }),
  );
  writeFileSync(credentialsPath, JSON.stringify({ type: 'external_account' }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A fake Google that routes by URL and records every request. */
function fakeGoogle(options: Options = {}) {
  const requests: Request[] = [];
  const signedFor = new Map<string, string>();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const error = (status: number, reason: string) =>
    json(status, { error: { code: status, message: options.quotedMessage ?? 'Resource Not Found', errors: [{ reason, message: options.quotedMessage }] } });
  const user = (primaryEmail: string, patch: Record<string, unknown> = {}) => ({
    id: 'directory-user-id-123',
    primaryEmail,
    suspended: false,
    archived: false,
    isMailboxSetup: true,
    ...patch,
  });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? String(init.body) : '';
    requests.push({ url, auth: new Headers(init?.headers).get('Authorization'), body });
    const path = decodeURIComponent(new URL(url).pathname);

    if (url.includes(':generateAccessToken')) {
      if (options.directoryMintStatus) return error(options.directoryMintStatus, 'forbidden');
      return json(200, { accessToken: DIRECTORY_TOKEN });
    }
    if (url.includes(':signJwt')) {
      const claims = JSON.parse(JSON.parse(body).payload) as { sub: string };
      const jwt = `jwt-${signedFor.size + 1}`;
      signedFor.set(jwt, claims.sub);
      return json(200, { signedJwt: jwt });
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      const subject = signedFor.get(new URLSearchParams(body).get('assertion') ?? '');
      if (subject === SUSPENDED || subject === GROUP) {
        return json(401, { error: 'unauthorized_client', error_description: `Client is unauthorized to retrieve access tokens for ${subject}` });
      }
      return json(200, { access_token: DWD_TOKEN, expires_in: 3600 });
    }

    const users = /^\/admin\/directory\/v1\/users\/(.+)$/.exec(path);
    if (users) {
      if (options.usersDenied) return error(403, 'forbidden');
      switch (users[1]) {
        case ALIAS:
          return json(200, user('dana.k@bank.example'));
        case SUSPENDED:
          return json(200, user(SUSPENDED, { suspended: true }));
        case SHARED:
          return json(200, user(SHARED));
        default:
          return error(404, 'notFound');
      }
    }
    const members = /^\/admin\/directory\/v1\/groups\/(.+)\/members$/.exec(path);
    if (members) {
      if (members[1] === GROUP) return json(200, { kind: 'admin#directory#members' });
      if (members[1] === ALLOWLIST_GROUP) {
        // Two pages, as the mirror pages them. The shared mailbox is a direct USER member unless a test says otherwise.
        const inGroup = options.sharedInGroup ?? 'direct';
        return new URL(url).searchParams.get('pageToken')
          ? json(200, { members: [{ email: 'nested-team@bank.example', type: 'GROUP' }] })
          : json(200, {
              members: [
                { email: 'dana.k@bank.example', type: 'USER' },
                inGroup === 'direct' ? { email: SHARED, type: 'USER' } : { email: 'other.user@bank.example', type: 'USER' },
              ],
              nextPageToken: 'next-page-token',
            });
      }
      return error(404, 'notFound');
    }
    const profile = /^\/gmail\/v1\/users\/(.+)\/profile$/.exec(path);
    if (profile) return json(200, { emailAddress: profile[1] === ALIAS ? 'dana.k@bank.example' : profile[1] });
    return error(404, 'notFound');
  }) as typeof fetch;

  return { fetchImpl, requests };
}

async function run(argv: string[], options: Options = {}, env: Record<string, string | undefined> = { GOOGLE_APPLICATION_CREDENTIALS: credentialsPath }) {
  const google = fakeGoogle(options);
  const lines: string[] = [];
  const code = await teamProbeMain(argv, {
    env,
    cwd: dir,
    io: { log: (line) => lines.push(line) },
    callerToken: () => async () => CALLER_TOKEN,
    directoryToken: () => null,
    fetchImpl: google.fetchImpl,
    http: { sleep: async () => undefined, random: () => 0.5 },
  });
  return { code, lines, ...google };
}

const base = (...rest: string[]) => ['--live', '--confirm-domain', DOMAIN, '--registration', registrationPath, ...rest];

/** Nothing that names a person, a token or a Google body: no address, no local part, no token-shaped string. */
function expectNothingSecret(lines: string[]) {
  const text = lines.join('\n');
  expect(text).not.toContain('@');
  for (const part of LOCAL_PARTS) expect(text, part).not.toContain(part);
  for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
  // Nothing token-shaped: no long run of token characters (the tenant id, which the announce line names, is not one).
  expect(text.replace(TENANT, '')).not.toMatch(/[A-Za-z0-9_-]{32,}/);
}

describe('the expected pattern of the trial tenant (thread T1)', () => {
  it('matches for an alias, a group, a suspended user and a shared mailbox, and the group mirror lists', async () => {
    const { code, lines } = await run(base(...ALL_ROLES));
    expect(code).toBe(0);
    expect(lines).toEqual([
      `LIVE Google run: google:probe-team against ${DOMAIN} for tenant ${TENANT}`,
      'T1 directoryToken scopes=2 status=200',
      // the allowlist (ingest) group first, across both pages, with the same two-scope token
      'T1 groupMirror status=200 members=3',
      // alias: 200, and the primary address is not the input
      'T1 alias users.get status=200 primaryEmailEqualsInput=no suspended=no archived=no isMailboxSetup=yes',
      'T1 alias members.list status=404 reason=notFound',
      'T1 alias dwd.token status=200',
      'T1 alias gmail.profile status=200 emailAddressEqualsInput=no',
      'T1 alias verdict matches=yes',
      // group: users.get 404, then 200 on members.list; the token mint is refused
      'T1 group users.get status=404 reason=notFound',
      'T1 group members.list status=200',
      'T1 group dwd.token status=401 error=unauthorized_client',
      'T1 group gmail.profile skipped=no_token',
      'T1 group verdict matches=yes',
      // suspended
      'T1 suspended users.get status=200 primaryEmailEqualsInput=yes suspended=yes archived=no isMailboxSetup=yes',
      'T1 suspended members.list status=404 reason=notFound',
      'T1 suspended dwd.token status=401 error=unauthorized_client',
      'T1 suspended gmail.profile skipped=no_token',
      'T1 suspended verdict matches=yes',
      // shared mailbox: everything succeeds
      'T1 shared users.get status=200 primaryEmailEqualsInput=yes suspended=no archived=no isMailboxSetup=yes',
      'T1 shared members.list status=404 reason=notFound',
      'T1 shared dwd.token status=200',
      'T1 shared gmail.profile status=200 emailAddressEqualsInput=yes',
      // and it is a direct USER member of the ingest group, as the live mirror requires
      'T1 shared ingestGroup directMember=yes',
      'T1 shared verdict matches=yes',
      'T1 summary addresses=4 matches=4 groupMirror=ok',
    ]);
  });

  it('mints the directory token with both scopes and uses it for the Directory, never for Gmail', async () => {
    const { requests } = await run(base(...ALL_ROLES));
    const mint = requests.filter((r) => r.url.includes(`${encodeURIComponent(DIR_SA)}:generateAccessToken`));
    expect(mint).toHaveLength(1);
    expect(JSON.parse(mint[0].body).scope).toEqual([...DIRECTORY_SCOPES]);
    const directory = requests.filter((r) => r.url.startsWith('https://admin.googleapis.com/'));
    expect(directory.length).toBeGreaterThan(0);
    for (const r of directory) expect(r.auth, r.url).toBe(`Bearer ${DIRECTORY_TOKEN}`);
    const gmail = requests.filter((r) => r.url.startsWith('https://gmail.googleapis.com/'));
    for (const r of gmail) expect(r.auth, r.url).toBe(`Bearer ${DWD_TOKEN}`);
  });

  it('reads no mail: Gmail sees only the profile of an address that got a token, and it asks for the address field', async () => {
    const { requests } = await run(base(...ALL_ROLES));
    const gmail = requests.filter((r) => r.url.startsWith('https://gmail.googleapis.com/'));
    // alias and shared got a token; the group and the suspended user did not
    expect(gmail).toHaveLength(2);
    for (const r of gmail) {
      expect(new URL(r.url).pathname).toMatch(/^\/gmail\/v1\/users\/[^/]+\/profile$/);
      expect(new URL(r.url).searchParams.get('fields')).toBe('emailAddress');
    }
    expect(requests.some((r) => /\/messages|\/threads|\/history|\/labels/.test(r.url))).toBe(false);
  });

  it('runs only the roles it is given', async () => {
    const { code, lines } = await run(base('--shared', SHARED));
    expect(code).toBe(0);
    expect(lines.filter((l) => l.startsWith('T1 shared '))).toHaveLength(6);
    expect(lines.some((l) => l.startsWith('T1 alias ') || l.startsWith('T1 group '))).toBe(false);
    expect(lines.at(-1)).toBe('T1 summary addresses=1 matches=1 groupMirror=ok');
  });
});

describe('a deviation is reported and exits 1', () => {
  // Audit item 3: the live mirror reads direct USER members only, so a team inbox outside the ingest group, or inside it
  // only through a nested group, is refused not_in_provider_group on every pass even though its card shows Ready.
  it.each(['absent', 'nested'] as const)('a shared mailbox that is not a direct member of the ingest group (%s) deviates', async (sharedInGroup) => {
    const { code, lines } = await run(base('--shared', SHARED), { sharedInGroup });
    expect(code).toBe(1);
    expect(lines).toContain('T1 shared ingestGroup directMember=no');
    expect(lines).toContain('T1 shared verdict matches=no');
    expect(lines.at(-1)).toBe('T1 summary addresses=1 matches=0 groupMirror=ok');
  });

  it('a 403 on users.get for every address (no Users read) deviates, with the status and the reason only', async () => {
    const { code, lines } = await run(base('--shared', SHARED, '--alias', ALIAS), { usersDenied: true });
    expect(code).toBe(1);
    expect(lines).toContain('T1 shared users.get status=403 reason=forbidden');
    expect(lines).toContain('T1 shared verdict matches=no');
    expect(lines).toContain('T1 alias verdict matches=no');
    expect(lines.at(-1)).toBe('T1 summary addresses=2 matches=0 groupMirror=ok');
  });

  it('a directory token that cannot be minted skips every Directory row and exits 1', async () => {
    const { code, lines, requests } = await run(base('--shared', SHARED), { directoryMintStatus: 403 });
    expect(code).toBe(1);
    expect(lines).toContain('T1 directoryToken scopes=2 status=403 reason=forbidden');
    expect(lines).toContain('T1 shared users.get status=none skipped=no_directory_token');
    expect(lines).toContain('T1 shared members.list status=none skipped=no_directory_token');
    expect(lines).toContain('T1 shared verdict matches=no');
    expect(lines).toContain('T1 groupMirror skipped=no_directory_token');
    expect(lines).toContain('T1 shared ingestGroup directMember=unknown');
    expect(requests.some((r) => r.url.startsWith('https://admin.googleapis.com/'))).toBe(false);
  });
});

describe('the output never carries an address, an id, a token or a Google message', () => {
  it('a clean run', async () => {
    const { lines } = await run(base(...ALL_ROLES));
    expectNothingSecret(lines);
  });

  it('a run where every Google error quotes an address in its message', async () => {
    const { lines } = await run(base(...ALL_ROLES), { usersDenied: true, quotedMessage: `Not Authorized to access ${SHARED} (${ALIAS})` });
    expect(lines).toContain('T1 shared users.get status=403 reason=forbidden');
    expectNothingSecret(lines);
  });

  it('a run where the directory mint fails with a quoted message', async () => {
    const { lines } = await run(base(...ALL_ROLES), { directoryMintStatus: 403, quotedMessage: `no access for ${DIR_SA}` });
    expectNothingSecret(lines);
    expect(lines.join('\n')).not.toContain('iam.gserviceaccount');
  });
});

describe('the probe refuses before any Google call, with one fixed code', () => {
  const CANARY = 'canary-person';
  // Built when the test runs: the registration file is written in beforeAll.
  const cases: Array<[string, () => string[], string]> = [
    ['no --live', () => ['--confirm-domain', DOMAIN, '--registration', registrationPath, '--shared', SHARED], 'arg_live_required'],
    ['no registration', () => ['--live', '--confirm-domain', DOMAIN, '--shared', SHARED], 'arg_missing'],
    ['an unreadable registration', () => ['--live', '--confirm-domain', DOMAIN, '--registration', join(dir, 'nope.json'), '--shared', SHARED], 'registration_file_unreadable'],
    ['a wrong --confirm-domain', () => ['--live', '--confirm-domain', 'other.example', '--registration', registrationPath, '--shared', SHARED], 'arg_confirm_domain'],
    ['no address at all', () => base(), 'arg_missing'],
    ['an address flag with no value', () => base('--shared'), 'arg_missing'],
    ['an address outside the domain', () => base('--shared', `${CANARY}@elsewhere.example`), 'arg_out_of_domain'],
    ['a malformed address', () => base('--shared', `${CANARY}@x@${DOMAIN}`), 'arg_malformed_address'],
    ['one address named under two roles', () => base('--shared', SHARED, '--alias', SHARED), 'arg_conflict'],
  ];

  it.each(cases)('%s', async (_name, argv, reason) => {
    const { code, lines, requests } = await run(argv());
    expect(code).toBe(1);
    expect(lines).toEqual([JSON.stringify({ evt: 'probe_error', reason })]);
    expect(requests).toEqual([]);
    expect(lines.join('\n')).not.toContain(CANARY);
  });

  it('no worker credential is a fixed class code, not a message', async () => {
    const { code, lines, requests } = await run(base('--shared', SHARED), {}, {});
    expect(code).toBe(1);
    expect(lines).toEqual([JSON.stringify({ evt: 'probe_error', reason: 'internal:Error' })]);
    expect(requests).toEqual([]);
  });
});
