// A fake Google for the connection probe (tests/google/probe.test.ts and
// tests/integration/probe-guard.test.ts). It routes by URL, remembers which
// claims each signed JWT carried, and records every request, so a test can
// assert that nothing named a mailbox the guard did not admit.

export const DWD = 'dwd-reader@proj-1.iam.gserviceaccount.com';
export const DIR_SA = 'dir-reader@proj-1.iam.gserviceaccount.com';
export const DRIVE_SA = 'drive-probe@proj-1.iam.gserviceaccount.com';
export const DIRECTORY_CONFIG_TOKEN = 'directory-config-token';
const MODIFY = 'https://www.googleapis.com/auth/gmail.modify';

export type World = {
  modifyIssued?: boolean;
  directoryDelegated?: boolean;
  driveWritable?: boolean;
  /** A subject delegation does not cover: its token exchange answers unauthorized_client. */
  uncovered?: string;
  /** signJwt as the directory SA is denied by IAM (403), as in production. */
  directorySignDenied?: boolean;
  /** signJwt as the directory SA answers this status and machine reason instead (Retry-After 0), or fails at the network. */
  directorySignFailure?: { status: number; body: unknown } | 'network';
  /** The token exchange for a directory-SA JWT fails at the network. */
  directoryExchangeNetworkError?: boolean;
  /** generateAccessToken is denied (403), as for a federated caller in self mode. */
  generateAccessTokenDenied?: boolean;
  /** The group members call answers 403. */
  groupDenied?: boolean;
};

export type Claims = { scope: string; iss: string; sub: string };
export type WorldRecord = {
  fetchImpl: typeof fetch;
  /** Every request, in order, with the bearer it carried. */
  requests: Array<{ url: string; auth: string | null }>;
  /** Every signJwt payload, in order. */
  signed: Claims[];
  /** Every successful delegated token exchange, by subject. */
  issued: string[];
};

export function world(opts: World = {}): WorldRecord {
  const byJwt = new Map<string, Claims>();
  const requests: WorldRecord['requests'] = [];
  const signed: Claims[] = [];
  const issued: string[] = [];
  let n = 0;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('Authorization');
    requests.push({ url, auth });
    const body = init?.body ? String(init.body) : '';
    if (url.includes(':signJwt')) {
      const claims = JSON.parse(JSON.parse(body).payload) as Claims;
      signed.push(claims);
      if (opts.directorySignDenied && claims.iss === DIR_SA) return json(403, { error: { errors: [{ reason: 'forbidden' }] } });
      if (opts.directorySignFailure && claims.iss === DIR_SA) {
        if (opts.directorySignFailure === 'network') throw new TypeError('fetch failed');
        return new Response(JSON.stringify(opts.directorySignFailure.body), {
          status: opts.directorySignFailure.status,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        });
      }
      n += 1;
      byJwt.set(`jwt-${n}`, claims);
      return json(200, { signedJwt: `jwt-${n}` });
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      const claims = byJwt.get(new URLSearchParams(body).get('assertion') ?? '');
      if (opts.directoryExchangeNetworkError && claims?.iss === DIR_SA) throw new TypeError('fetch failed');
      if (opts.uncovered && claims?.sub === opts.uncovered) return json(401, { error: 'unauthorized_client' });
      if (claims?.scope === MODIFY && !opts.modifyIssued) return json(401, { error: 'unauthorized_client' });
      if (claims?.iss === DIR_SA && !opts.directoryDelegated) return json(401, { error: 'unauthorized_client' });
      if (claims) issued.push(claims.sub);
      return json(200, { access_token: `access-for-${claims?.scope}`, expires_in: 3600 });
    }
    if (url.includes(':generateAccessToken')) {
      if (opts.generateAccessTokenDenied) return json(403, { error: { errors: [{ reason: 'forbidden' }] } });
      return json(200, { accessToken: 'sa-token' });
    }
    if (url.includes('/profile')) return json(200, { messagesTotal: 42 });
    if (url.includes('format=raw') || url.includes('/threads?')) return json(403, { error: { errors: [{ reason: 'forbidden' }] } });
    if (url.includes('/groups/')) {
      if (opts.groupDenied) return json(403, { error: { errors: [{ reason: 'forbidden' }] } });
      return json(200, { members: [{ id: '1' }, { id: '2' }] });
    }
    if (url.includes('/reports/v1/')) return json(403, { error: { errors: [{ reason: 'forbidden' }] } });
    if (url.includes('/drive/v3/drives/')) return json(200, { id: 'drive-1', capabilities: { canAddChildren: !!opts.driveWritable } });
    return json(404, {});
  }) as typeof fetch;
  return { fetchImpl, requests, signed, issued };
}

/** Requests and JWT payloads that name `address` anywhere: a Gmail URL, a signJwt sub, an issued token. */
export function namedIn(record: WorldRecord, address: string) {
  const encoded = encodeURIComponent(address);
  return {
    gmailRequests: record.requests.filter((r) => r.url.startsWith('https://gmail.googleapis.com/') && (r.url.includes(encoded) || r.url.includes(address))),
    signedFor: record.signed.filter((c) => c.sub === address),
    issuedFor: record.issued.filter((sub) => sub === address),
  };
}
