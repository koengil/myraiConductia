import http from 'node:http';
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * A minimal OIDC issuer for the local work-identity broker tests (issue #316).
 * It speaks two dialects on one port; a test picks one by the provider URL it
 * gives Supabase Auth.
 *
 * Azure dialect (primary). Supabase Auth's `azure` provider takes a `url` and
 * derives its endpoints from it; for a host that is not a Microsoft authority
 * it also clears the expected issuer (supabase/auth `azure.go`), so the real
 * provider runs end to end against this mock:
 *   [auth.external.azure] url = http://host.docker.internal:<port>/<tenant>
 * The mock answers as Entra does: v2.0 discovery, authorize and token under the
 * tenant, a JWKS, and an RS256 `id_token` carrying `tid`, `acct`, `xms_edov`
 * and `email`. The provider reads user data only from that id_token (there is
 * no UserInfo or Graph call). The token's `iss` is the token's own `tid` (a
 * foreign tenant is a different issuer), served from the same Host the caller
 * used, which is what OIDC discovery re-checks. CI run 39064775122 settled the
 * spike: the CLI's GoTrue v2.196.0 runs its real azure provider against it.
 *
 * One thing the mock must state itself. GoTrue applies its Azure token parsing
 * (every non-standard claim into `custom_claims`, `email_verified` from
 * `xms_edov`) only to a Microsoft issuer (`login.microsoftonline.com`), which a
 * local issuer cannot be; any other issuer goes through its generic OIDC
 * parser, which keeps the standard claims and a literal `custom_claims` object
 * only (supabase/auth v2.196.0 `provider/oidc.go`). Run 39087361279 showed the
 * result: a member stored with no `tid`, `acct` or `email_verified`, refused
 * with organization_mismatch. So the azure id_token also carries
 * `custom_claims` and `email_verified` exactly as `parseAzureIDToken` and
 * `IsEmailVerified` would derive them from the Entra claims above: what the
 * app and the SQL rule see is then what a real Entra sign-in stores.
 *
 * Keycloak dialect (fallback, and the only dialect for the Google journey).
 * Google's provider only talks to Google, so the local stack wires this issuer
 * as the `keycloak` provider (`[auth.external.keycloak]`, url
 * `http://host.docker.internal:<port>/realms/x`). Keycloak runs through the
 * same Auth code paths that matter here (PKCE flow state, the callback's
 * automatic identity linking in `DetermineAccountLinking`, identity_data
 * rewrite, the Custom Access Token hook at exchange) and copies every
 * non-standard userinfo claim into `identity_data.custom_claims`, which is
 * exactly where the real providers put Google `hd` and Microsoft `tid`. The
 * substitution is disclosed in docs/03-engineering/work-identity-contract.md;
 * it proves broker semantics, not Google or Microsoft behavior (HQ1/HQ2).
 *
 * The test controls WHO signs in: `GET /_next?id=<json>` sets the identity the
 * next authorization will assert. Each authorization captures the identity at
 * that moment, so a later `/_next` cannot change a flow already in progress.
 *
 * Endpoints:
 *   keycloak (any realm name under /realms/<realm>):
 *     GET  /.well-known/openid-configuration
 *     GET  /protocol/openid-connect/auth      302 back to redirect_uri with code+state
 *     POST /protocol/openid-connect/token     opaque bearer token for that code
 *     GET  /protocol/openid-connect/userinfo  the captured identity's claims
 *   azure (any tenant segment, /<tenant>):
 *     GET  /v2.0/.well-known/openid-configuration
 *     GET  /discovery/v2.0/keys               JWKS (RS256)
 *     GET  /oauth2/v2.0/authorize             302 back to redirect_uri with code+state
 *     POST /oauth2/v2.0/token                 access_token + signed id_token
 *   shared:
 *     GET  /_next?id=<json>                   set the next identity
 *     GET  /_calls                            authorizations served so far (JSON)
 *
 * Azure id_token claims come from the identity: every field except
 * `email_verified` is copied through (so `acct`, `xms_edov`, `idp`, `tid`,
 * `oid` are the test's to set). `email_verified: false` with no `xms_edov`
 * becomes `xms_edov: false`, the only way Entra says the address is
 * unverified. `tid` defaults to the URL's tenant segment. `custom_claims` and
 * `email_verified` are then derived as GoTrue's Azure parser would (above).
 */
export type MockIdentity = {
  sub: string;
  email: string;
  /** Defaults to true. False lets a test assert the unverified-email denial. */
  email_verified?: boolean;
  name?: string;
  /** Google Workspace hosted domain; absent for consumer accounts. */
  hd?: string;
  /** Microsoft Entra tenant id. */
  tid?: string;
  /**
   * Any further custom claims. Azure dialect: acct (0 member, 1 guest),
   * xms_edov, idp, oid. Absent means the claim is not emitted.
   */
  [claim: string]: unknown;
};

export const DEFAULT_MOCK_OIDC_PORT = 56430;

// ---- Azure dialect helpers --------------------------------------------------

type AzureKey = { privateKey: KeyObject; kid: string; jwk: Record<string, unknown> };
let azureKey: AzureKey | undefined;

/** One RSA key per process, generated on first use; the JWKS publishes its public half. */
function azureSigningKey(): AzureKey {
  if (!azureKey) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = 'mock-azure-key-1';
    azureKey = {
      privateKey,
      kid,
      jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' },
    };
  }
  return azureKey;
}

const base64url = (value: string | Buffer): string =>
  (typeof value === 'string' ? Buffer.from(value, 'utf8') : value).toString('base64url');

function signRs256(claims: Record<string, unknown>): string {
  const { privateKey, kid } = azureSigningKey();
  const signingInput = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

/** OIDC `at_hash`: the left half of SHA-256 of the access token, base64url. */
function accessTokenHash(accessToken: string): string {
  return base64url(createHash('sha256').update(accessToken).digest().subarray(0, 16));
}

/**
 * The Entra-shaped v2.0 id_token claims for `identity`. Security-relevant
 * claims (iss, aud, tid, times) are set last so an identity cannot override
 * them by accident; `tid` falls back to the tenant segment of the URL.
 */
function azureIdTokenClaims(
  identity: MockIdentity,
  context: { base: string; tenant: string; clientId: string; nonce?: string; accessToken: string },
): Record<string, unknown> {
  const { email_verified: emailVerified, ...rest } = identity;
  const tid = typeof identity.tid === 'string' && identity.tid ? identity.tid : context.tenant;
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    name: 'Mock Banker',
    oid: identity.sub,
    preferred_username: identity.email,
    ...rest,
    ver: '2.0',
    iss: `${context.base}/${tid}/v2.0`,
    aud: context.clientId,
    tid,
    iat: now,
    nbf: now,
    exp: now + 3600,
    at_hash: accessTokenHash(context.accessToken),
  };
  // Entra has no email_verified claim; it says "unverified" through xms_edov.
  if (emailVerified === false && !('xms_edov' in identity)) claims.xms_edov = false;
  if (context.nonce) claims.nonce = context.nonce;
  return withAzureParsing(claims);
}

/** Claims GoTrue's Azure parser drops from `custom_claims` (v2.196.0 `removeAzureClaimsFromCustomClaims`). */
const AZURE_PARSER_DROPPED = new Set([
  'aud', 'iss', 'iat', 'nbf', 'exp', 'c_hash', 'at_hash', 'aio', 'nonce', 'rh', 'uti', 'jti', 'ver',
  'sub', 'name', 'preferred_username',
]);

/**
 * Adds what GoTrue's Azure parser would store, for the generic parser to copy
 * (see the header): `custom_claims` is every claim but the dropped ones, and
 * `email_verified` follows `IsEmailVerified`: with no `xms_edov`, verified when
 * an email is present; otherwise only `true`, `"1"` or `"true"` with an email.
 */
function withAzureParsing(claims: Record<string, unknown>): Record<string, unknown> {
  const custom = Object.fromEntries(Object.entries(claims).filter(([key]) => !AZURE_PARSER_DROPPED.has(key)));
  const email = typeof claims.email === 'string' && claims.email !== '';
  const edov = claims.xms_edov;
  const verified =
    edov === undefined || edov === null ? email : email && (edov === true || edov === '1' || edov === 'true');
  return { ...claims, custom_claims: custom, email_verified: verified };
}

/** `client_id` from an HTTP Basic client_secret_basic header, if any. */
function basicClientId(header: string | undefined): string {
  const encoded = /^Basic\s+(.+)$/i.exec(header ?? '')?.[1];
  if (!encoded) return '';
  return decodeURIComponent(Buffer.from(encoded, 'base64').toString('utf8').split(':')[0] ?? '');
}

const AZURE_PATH =
  /^\/([^/]+)\/(v2\.0\/\.well-known\/openid-configuration|discovery\/v2\.0\/keys|oauth2\/v2\.0\/authorize|oauth2\/v2\.0\/token)$/;

export function createMockOidc(): {
  handler: http.RequestListener;
  setNext: (identity: MockIdentity) => void;
  calls: Array<{ at: string; sub: string; email: string }>;
} {
  let next: MockIdentity = { sub: 'mock-default', email: 'default@mock-oidc.test' };
  const codes = new Map<string, MockIdentity>();
  const tokens = new Map<string, MockIdentity>();
  const azureCodes = new Map<string, { identity: MockIdentity; clientId: string; nonce?: string }>();
  const calls: Array<{ at: string; sub: string; email: string }> = [];

  const json = (response: http.ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  const handler: http.RequestListener = (request, response) => {
    const url = new URL(request.url ?? '/', 'http://mock-oidc.local');
    const path = url.pathname;

    if (path === '/_next') {
      try {
        next = JSON.parse(url.searchParams.get('id') ?? '') as MockIdentity;
      } catch {
        json(response, 400, { error: 'id must be JSON' });
        return;
      }
      json(response, 200, { ok: true });
      return;
    }

    if (path === '/_calls') {
      json(response, 200, { calls });
      return;
    }

    const azure = AZURE_PATH.exec(path);
    if (azure) {
      const tenant = decodeURIComponent(azure[1]);
      const route = azure[2];
      const origin = `http://${request.headers.host ?? 'localhost'}`;
      const authority = `${origin}/${azure[1]}`;

      if (route === 'v2.0/.well-known/openid-configuration') {
        json(response, 200, {
          issuer: `${authority}/v2.0`,
          authorization_endpoint: `${authority}/oauth2/v2.0/authorize`,
          token_endpoint: `${authority}/oauth2/v2.0/token`,
          jwks_uri: `${authority}/discovery/v2.0/keys`,
          response_types_supported: ['code', 'id_token', 'code id_token', 'id_token token'],
          subject_types_supported: ['pairwise'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
          scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
          claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'nbf', 'name', 'email', 'preferred_username', 'oid', 'tid', 'ver'],
        });
        return;
      }

      if (route === 'discovery/v2.0/keys') {
        json(response, 200, { keys: [azureSigningKey().jwk] });
        return;
      }

      if (route === 'oauth2/v2.0/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri');
        if (!redirectUri) {
          json(response, 400, { error: 'redirect_uri required' });
          return;
        }
        const code = randomBytes(16).toString('hex');
        azureCodes.set(code, {
          identity: next,
          clientId: url.searchParams.get('client_id') ?? '',
          nonce: url.searchParams.get('nonce') ?? undefined,
        });
        calls.push({ at: new Date().toISOString(), sub: next.sub, email: next.email });
        const target = new URL(redirectUri);
        target.searchParams.set('code', code);
        const state = url.searchParams.get('state');
        if (state !== null) target.searchParams.set('state', state);
        response.writeHead(302, { location: target.toString() });
        response.end();
        return;
      }

      // oauth2/v2.0/token
      if (request.method !== 'POST') {
        json(response, 405, { error: 'method_not_allowed' });
        return;
      }
      let raw = '';
      request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
      request.on('end', () => {
        const form = new URLSearchParams(raw);
        const grant = azureCodes.get(form.get('code') ?? '');
        if (!grant) {
          json(response, 400, { error: 'invalid_grant' });
          return;
        }
        azureCodes.delete(form.get('code') ?? '');
        const accessToken = randomBytes(24).toString('hex');
        const clientId = grant.clientId || form.get('client_id') || basicClientId(request.headers.authorization);
        const idToken = signRs256(
          azureIdTokenClaims(grant.identity, { base: origin, tenant, clientId, nonce: grant.nonce, accessToken }),
        );
        json(response, 200, {
          token_type: 'Bearer',
          scope: 'openid profile email',
          expires_in: 3599,
          ext_expires_in: 3599,
          access_token: accessToken,
          id_token: idToken,
        });
      });
      return;
    }

    const realm = /^(\/realms\/[^/]+)/.exec(path)?.[1];
    if (!realm) {
      json(response, 404, { error: 'not_found' });
      return;
    }
    const issuer = `http://${request.headers.host ?? 'localhost'}${realm}`;
    const rest = path.slice(realm.length);

    if (rest === '/.well-known/openid-configuration') {
      json(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
        token_endpoint: `${issuer}/protocol/openid-connect/token`,
        userinfo_endpoint: `${issuer}/protocol/openid-connect/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['none'],
        scopes_supported: ['openid', 'email', 'profile'],
      });
      return;
    }

    if (rest === '/protocol/openid-connect/auth') {
      const redirectUri = url.searchParams.get('redirect_uri');
      if (!redirectUri) {
        json(response, 400, { error: 'redirect_uri required' });
        return;
      }
      const code = randomBytes(16).toString('hex');
      codes.set(code, next);
      calls.push({ at: new Date().toISOString(), sub: next.sub, email: next.email });
      const target = new URL(redirectUri);
      target.searchParams.set('code', code);
      const state = url.searchParams.get('state');
      if (state !== null) target.searchParams.set('state', state);
      response.writeHead(302, { location: target.toString() });
      response.end();
      return;
    }

    if (rest === '/protocol/openid-connect/token' && request.method === 'POST') {
      let raw = '';
      request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
      request.on('end', () => {
        const code = new URLSearchParams(raw).get('code') ?? '';
        const identity = codes.get(code);
        if (!identity) {
          json(response, 400, { error: 'invalid_grant' });
          return;
        }
        codes.delete(code);
        const accessToken = randomBytes(24).toString('hex');
        tokens.set(accessToken, identity);
        json(response, 200, { access_token: accessToken, token_type: 'bearer', expires_in: 3600 });
      });
      return;
    }

    if (rest === '/protocol/openid-connect/userinfo') {
      const token = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const identity = tokens.get(token);
      if (!identity) {
        json(response, 401, { error: 'invalid_token' });
        return;
      }
      json(response, 200, {
        name: 'Mock Banker',
        ...identity,
        email_verified: identity.email_verified ?? true,
      });
      return;
    }

    json(response, 404, { error: 'not_found' });
  };

  return { handler, setNext: (identity) => (next = identity), calls };
}

export function startMockOidc(
  port: number = DEFAULT_MOCK_OIDC_PORT,
): Promise<{ url: string; close: () => Promise<void> }> {
  const { handler } = createMockOidc();
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // 0.0.0.0, not 127.0.0.1: the Auth container reaches this through
    // host.docker.internal, which is not the loopback interface.
    server.listen(port, '0.0.0.0', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}

/** Points the next authorization at `identity`. `base` is the issuer host, e.g. http://127.0.0.1:56430. */
export async function setNextMockIdentity(base: string, identity: MockIdentity): Promise<void> {
  const response = await fetch(`${base}/_next?id=${encodeURIComponent(JSON.stringify(identity))}`);
  if (!response.ok) throw new Error(`mock OIDC refused the identity: ${response.status}`);
}

// Executed directly by Playwright's webServer or by hand for the broker tests.
if (process.argv[1]?.endsWith('mockOidc.ts')) {
  const port = Number(process.env.MOCK_OIDC_PORT ?? DEFAULT_MOCK_OIDC_PORT);
  void startMockOidc(port).then(({ url }) => {
    console.log(`mock OIDC listening on ${url}`);
  });
}
