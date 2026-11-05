import { createVerify, createPublicKey } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setNextMockIdentity, startMockOidc } from '../e2e/support/mockOidc';

/**
 * The Azure dialect of the work-identity mock issuer (#316). GoTrue's real azure
 * provider is pointed at it in CI; this pins the wire shape the provider relies
 * on without a stack: v2.0 discovery whose issuer matches the token's `iss`, a
 * JWKS that verifies the RS256 id_token, and the Entra-shaped claims.
 */
let mock: { url: string; close: () => Promise<void> };

beforeAll(async () => {
  mock = await startMockOidc(0);
});
afterAll(async () => {
  await mock.close();
});

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function signIn(tenant: string, identity: Parameters<typeof setNextMockIdentity>[1]) {
  await setNextMockIdentity(mock.url, identity);
  const authorize = await fetch(
    `${mock.url}/${tenant}/oauth2/v2.0/authorize?client_id=client-1&state=st&nonce=n-1&redirect_uri=${encodeURIComponent('http://localhost/cb')}`,
    { redirect: 'manual' },
  );
  expect(authorize.status).toBe(302);
  const target = new URL(authorize.headers.get('location') as string);
  expect(target.searchParams.get('state')).toBe('st');
  const token = await fetch(`${mock.url}/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: target.searchParams.get('code') as string, grant_type: 'authorization_code' }),
  });
  expect(token.status).toBe(200);
  return (await token.json()) as { id_token: string; access_token: string };
}

describe('mock OIDC, azure dialect', () => {
  it('serves v2.0 discovery whose issuer matches the id_token and a JWKS that verifies it', async () => {
    const tid = '5b0a8d5e-3c1f-4f6e-9a7d-2e4c6b8a1f30';
    const { id_token: idToken } = await signIn(tid, {
      sub: 's1',
      email: 'a@firm.test',
      tid,
      acct: 0,
      xms_edov: true,
    });
    const [header, payload, signature] = idToken.split('.');
    const claims = decode(payload);

    const discovery = (await (await fetch(`${claims.iss}/.well-known/openid-configuration`)).json()) as {
      issuer: string;
      jwks_uri: string;
    };
    expect(discovery.issuer).toBe(claims.iss);

    const jwks = (await (await fetch(discovery.jwks_uri)).json()) as { keys: Array<Record<string, unknown>> };
    const jwk = jwks.keys.find((key) => key.kid === decode(header).kid);
    expect(jwk).toBeTruthy();
    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(createPublicKey({ key: jwk as never, format: 'jwk' }), Buffer.from(signature, 'base64url'));
    expect(verified).toBe(true);

    expect(claims).toMatchObject({
      ver: '2.0',
      aud: 'client-1',
      sub: 's1',
      email: 'a@firm.test',
      tid,
      acct: 0,
      xms_edov: true,
      nonce: 'n-1',
    });
    // What GoTrue's Azure parser would store (the generic parser copies these through).
    expect(claims.email_verified).toBe(true);
    expect(claims.custom_claims).toMatchObject({ tid, acct: 0, xms_edov: true, oid: 's1', email: 'a@firm.test' });
    for (const dropped of ['iss', 'aud', 'sub', 'nonce', 'ver', 'at_hash', 'name', 'preferred_username']) {
      expect(claims.custom_claims, dropped).not.toHaveProperty(dropped);
    }
  });

  it('issues a foreign tenant under its own issuer and leaves xms_edov absent when the identity has none', async () => {
    const { id_token: idToken } = await signIn('any-tenant', {
      sub: 's2',
      email: 'b@firm.test',
      tid: 'other-tenant',
      acct: 1,
      idp: 'live.com',
    });
    const claims = decode(idToken.split('.')[1]);
    expect(String(claims.iss)).toMatch(/\/other-tenant\/v2\.0$/);
    expect(claims).toMatchObject({ tid: 'other-tenant', acct: 1, idp: 'live.com' });
    expect(claims).not.toHaveProperty('xms_edov');
    // IsEmailVerified: no xms_edov and an email present counts as verified.
    expect(claims.email_verified).toBe(true);
    expect(claims.custom_claims).toMatchObject({ tid: 'other-tenant', acct: 1, idp: 'live.com' });
    expect(claims.custom_claims).not.toHaveProperty('xms_edov');
  });

  it('expresses an unverified email as xms_edov false and rejects an unknown code', async () => {
    const { id_token: idToken } = await signIn('t', { sub: 's3', email: 'c@firm.test', email_verified: false });
    expect(decode(idToken.split('.')[1])).toMatchObject({ xms_edov: false, email_verified: false });
    const bad = await fetch(`${mock.url}/t/oauth2/v2.0/token`, { method: 'POST', body: 'code=nope' });
    expect(bad.status).toBe(400);
  });

  it('leaves the keycloak routes alone', async () => {
    const response = await fetch(`${mock.url}/realms/x/.well-known/openid-configuration`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token_endpoint: expect.stringContaining('/realms/x/protocol/openid-connect/token') });
  });
});
