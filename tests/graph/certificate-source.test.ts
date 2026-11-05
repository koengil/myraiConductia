// @vitest-environment node
import { constants, createHash, generateKeyPairSync, verify } from 'node:crypto';
import type { INetworkModule, NetworkRequestOptions, NetworkResponse } from '@azure/msal-node';
import { describe, expect, it, vi } from 'vitest';

import {
  buildClientAssertion,
  certificateSourceFromRef,
  envPemCertificateSource,
  keyVaultCertificateSource,
  parseKeyVaultKeyId,
} from '@/lib/graph/reader/certificateSource';
import { createReaderTokenProvider, readerMsalConfiguration, type ReaderRegistration } from '@/lib/graph/reader/token';
import { readerCapability } from './readerCapability';

/*
 * The reader's certificate credential (Q17): the envPem and Key Vault
 * signing paths, and MSAL's use of the assertion through its clientAssertion
 * callback. Nothing leaves the process: Key Vault is a stubbed fetch, and
 * MSAL runs with a network module that answers from memory.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SHA256_THUMB = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SHA1_THUMB = '0123456789abcdef0123456789abcdef01234567';
const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = '66666666-7777-8888-9999-000000000000';
const TOKEN_ENDPOINT = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;

function decode(jwt: string) {
  const [h, p, s] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(p, 'base64url').toString()),
    signingInput: `${h}.${p}`,
    signature: Buffer.from(s, 'base64url'),
  };
}

describe('envPem certificate source', () => {
  it('signs a PS256 assertion with x5t#S256 for a SHA-256 thumbprint', async () => {
    const source = envPemCertificateSource(readerCapability, { pem: PEM, thumbprint: SHA256_THUMB });
    const jwt = await buildClientAssertion(source, { clientId: CLIENT, tokenEndpoint: TOKEN_ENDPOINT, now: 1_800_000_000, jti: 'j-1' });
    const { header, payload, signingInput, signature } = decode(jwt);

    expect(header).toEqual({ alg: 'PS256', typ: 'JWT', 'x5t#S256': Buffer.from(SHA256_THUMB, 'hex').toString('base64url') });
    expect(payload).toEqual({
      aud: TOKEN_ENDPOINT,
      iss: CLIENT,
      sub: CLIENT,
      jti: 'j-1',
      nbf: 1_800_000_000,
      iat: 1_800_000_000,
      exp: 1_800_000_600,
    });
    expect(
      verify('sha256', Buffer.from(signingInput), { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, signature),
    ).toBe(true);
  });

  it('signs RS256 with x5t for a SHA-1 thumbprint', async () => {
    const source = envPemCertificateSource(readerCapability, { pem: PEM, thumbprint: SHA1_THUMB.toUpperCase() });
    const { header, signingInput, signature } = decode(
      await buildClientAssertion(source, { clientId: CLIENT, tokenEndpoint: TOKEN_ENDPOINT }),
    );
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT', x5t: Buffer.from(SHA1_THUMB, 'hex').toString('base64url') });
    expect(verify('sha256', Buffer.from(signingInput), publicKey, signature)).toBe(true);
  });

  it('refuses a bad key or thumbprint without echoing the input', () => {
    expect(() => envPemCertificateSource(readerCapability, { pem: 'not-a-key-SECRET', thumbprint: SHA256_THUMB })).toThrow(
      /^The reader certificate key is not a readable PEM private key$/,
    );
    expect(() => envPemCertificateSource(readerCapability, { pem: PEM, thumbprint: 'abc' })).toThrow('40 (SHA-1) or 64 (SHA-256)');
  });
});

describe('Key Vault certificate source', () => {
  const KEY_ID = 'https://reader-vault.vault.azure.net/keys/graph-reader/0123abcd';

  it('signs through the Key Vault sign API; the key never leaves the vault', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ kid: KEY_ID, value: Buffer.from('vault-signature').toString('base64url') }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const getVaultToken = vi.fn(async () => 'mi-token');
    const source = keyVaultCertificateSource(readerCapability, { keyId: KEY_ID, thumbprint: SHA256_THUMB, getVaultToken, fetchImpl });

    const jwt = await buildClientAssertion(source, { clientId: CLIENT, tokenEndpoint: TOKEN_ENDPOINT });
    const { header, signingInput, signature } = decode(jwt);

    expect(header.alg).toBe('PS256');
    expect(signature.toString()).toBe('vault-signature');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`${KEY_ID}/sign?api-version=7.4`);
    expect(requests[0].init.method).toBe('POST');
    expect(new Headers(requests[0].init.headers).get('Authorization')).toBe('Bearer mi-token');
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      alg: 'PS256',
      value: createHash('sha256').update(signingInput).digest('base64url'),
    });
  });

  it('fails closed when Key Vault refuses', async () => {
    const fetchImpl = (async () => new Response('{"error":{"code":"Forbidden"}}', { status: 403 })) as typeof fetch;
    const source = keyVaultCertificateSource(readerCapability, { keyId: KEY_ID, thumbprint: SHA256_THUMB, getVaultToken: async () => 't', fetchImpl });
    await expect(buildClientAssertion(source, { clientId: CLIENT, tokenEndpoint: TOKEN_ENDPOINT })).rejects.toThrow(
      'Key Vault sign failed: 403',
    );
  });

  it('accepts only a versioned key on a Key Vault host', () => {
    expect(parseKeyVaultKeyId(`${KEY_ID}/`).toString()).toBe(KEY_ID);
    expect(() => parseKeyVaultKeyId('https://evil.example/keys/a/b')).toThrow('vault.azure.net');
    expect(() => parseKeyVaultKeyId('https://reader-vault.vault.azure.net/keys/graph-reader')).toThrow('/keys/<name>/<version>');
    expect(() => parseKeyVaultKeyId('http://reader-vault.vault.azure.net/keys/a/b')).toThrow('https');
  });
});

describe('certificateSourceFromRef', () => {
  it('resolves env: to the PEM in the named variable and keyvault: to the vault', () => {
    const env = { GRAPH_READER_CERT_PEM: PEM.replace(/\n/g, '\\n') } as unknown as NodeJS.ProcessEnv;
    expect(certificateSourceFromRef(readerCapability, 'env:GRAPH_READER_CERT_PEM', SHA256_THUMB, { env }).kind).toBe('envPem');
    expect(
      certificateSourceFromRef(readerCapability, 'keyvault:https://v.vault.azure.net/keys/k/1', SHA256_THUMB, { getVaultToken: async () => 't' }).kind,
    ).toBe('keyVault');
  });

  it('never accepts key material or an unknown scheme in the reference', () => {
    expect(() => certificateSourceFromRef(readerCapability, PEM, SHA256_THUMB)).toThrow('never hold key material');
    expect(() => certificateSourceFromRef(readerCapability, 'file:/etc/key.pem', SHA256_THUMB)).toThrow('keyvault: or env:');
    expect(() => certificateSourceFromRef(readerCapability, 'env:MISSING_VAR', SHA256_THUMB, { env: {} as NodeJS.ProcessEnv })).toThrow(
      'MISSING_VAR is not set',
    );
    expect(() => certificateSourceFromRef(readerCapability, null, SHA256_THUMB)).toThrow('no cert_secret_ref');
  });

  it('refuses env: in production, where the key stays in Key Vault', () => {
    const env = { NEXT_PUBLIC_APP_ENV: 'prod', GRAPH_READER_CERT_PEM: PEM } as unknown as NodeJS.ProcessEnv;
    expect(() => certificateSourceFromRef(readerCapability, 'env:GRAPH_READER_CERT_PEM', SHA256_THUMB, { env })).toThrow(
      'env: certificate references are refused in production',
    );
    expect(
      certificateSourceFromRef(readerCapability, 'keyvault:https://v.vault.azure.net/keys/k/1', SHA256_THUMB, { env, getVaultToken: async () => 't' })
        .kind,
    ).toBe('keyVault');
  });
});

describe('MSAL token acquisition with the assertion callback', () => {
  const registration: ReaderRegistration = {
    tenantId: 't-1',
    msTenantId: TENANT,
    clientId: CLIENT,
    certThumbprint: SHA256_THUMB,
    certSecretRef: 'env:GRAPH_READER_CERT_PEM',
  };

  /** Answers MSAL from memory: authority metadata, then the token endpoint. */
  function fakeMsalNetwork() {
    const posts: Array<{ url: string; body: URLSearchParams }> = [];
    const gets: string[] = [];
    const network: INetworkModule = {
      async sendGetRequestAsync<T>(url: string): Promise<NetworkResponse<T>> {
        gets.push(url);
        if (url.includes('openid-configuration')) {
          return {
            status: 200,
            headers: {},
            body: {
              token_endpoint: TOKEN_ENDPOINT,
              issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
              authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
              end_session_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout`,
              jwks_uri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
            } as T,
          };
        }
        if (url.includes('discovery/instance')) {
          return {
            status: 200,
            headers: {},
            body: {
              tenant_discovery_endpoint: `https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration`,
              metadata: [
                {
                  preferred_network: 'login.microsoftonline.com',
                  preferred_cache: 'login.windows.net',
                  aliases: ['login.microsoftonline.com', 'login.windows.net'],
                },
              ],
            } as T,
          };
        }
        throw new Error(`unexpected GET ${url}`);
      },
      async sendPostRequestAsync<T>(url: string, options?: NetworkRequestOptions): Promise<NetworkResponse<T>> {
        posts.push({ url, body: new URLSearchParams(String(options?.body ?? '')) });
        return {
          status: 200,
          headers: {},
          body: { token_type: 'Bearer', expires_in: 3599, ext_expires_in: 3599, access_token: `graph-token-${posts.length}` } as T,
        };
      },
    };
    return { network, posts, gets };
  }

  it('hands MSAL a certificate assertion for the tenant token endpoint and caches the token', async () => {
    const { network, posts } = fakeMsalNetwork();
    const certificateSource = envPemCertificateSource(readerCapability, { pem: PEM, thumbprint: SHA256_THUMB });
    const getToken = createReaderTokenProvider(readerCapability, registration, { certificateSource, networkClient: network });

    expect(await getToken()).toBe('graph-token-1');
    expect(posts).toHaveLength(1);
    const body = posts[0].body;
    expect(posts[0].url.startsWith(TOKEN_ENDPOINT)).toBe(true);
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('scope')).toContain('https://graph.microsoft.com/.default');
    expect(body.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    expect(body.get('client_secret')).toBeNull();
    const assertion = decode(body.get('client_assertion')!);
    expect(assertion.payload).toMatchObject({ aud: TOKEN_ENDPOINT, iss: CLIENT, sub: CLIENT });
    expect(
      verify(
        'sha256',
        Buffer.from(assertion.signingInput),
        { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
        assertion.signature,
      ),
    ).toBe(true);

    // Served from MSAL's cache, then refreshed on demand (a 401 from Graph).
    expect(await getToken()).toBe('graph-token-1');
    expect(posts).toHaveLength(1);
    expect(await getToken({ forceRefresh: true })).toBe('graph-token-2');
    expect(posts).toHaveLength(2);
  });

  it('a token request that hangs rejects with a TimeoutError at the deadline (#409 F4)', async () => {
    const { network } = fakeMsalNetwork();
    const hung: INetworkModule = { ...network, sendPostRequestAsync: () => new Promise(() => undefined) };
    const certificateSource = envPemCertificateSource(readerCapability, { pem: PEM, thumbprint: SHA256_THUMB });
    const getToken = createReaderTokenProvider(readerCapability, registration, {
      certificateSource,
      networkClient: hung,
      timeoutMs: 20,
    });
    await expect(getToken()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('refuses a shared authority: the reader is single-tenant', () => {
    const certificateSource = envPemCertificateSource(readerCapability, { pem: PEM, thumbprint: SHA256_THUMB });
    expect(() => readerMsalConfiguration({ ...registration, msTenantId: 'common' }, { certificateSource })).toThrow(
      'not a shared authority',
    );
    expect(() => readerMsalConfiguration({ ...registration, clientId: 'fixture' }, { certificateSource })).toThrow(
      'client id must be a GUID',
    );
  });
});
