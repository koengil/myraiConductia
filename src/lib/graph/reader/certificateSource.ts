// Where the reader's certificate key lives, and how a client assertion is
// signed with it (ADR-005, design Q3 and Q17).
//
// graph_reader_registrations.cert_secret_ref names the key; it never holds
// key material. Two schemes:
//
//   keyvault:https://<vault>.vault.azure.net/keys/<name>/<version>
//       The production path (Q17). The certificate is non-exportable in Azure
//       Key Vault; the worker's managed identity calls the Key Vault sign API,
//       so the private key never leaves the vault.
//   env:<VARIABLE>
//       The fallback while Azure is being procured, and CI: a PEM private key
//       in the worker's environment. Against the Conductia-owned test tenant
//       only (synthetic data), never a bank's. Refused when
//       NEXT_PUBLIC_APP_ENV=prod, as the fixture reader is.
//
// Either way the worker builds the JWT itself and MSAL receives it through
// its clientAssertion callback (@azure/msal-node NodeAuthOptions.clientAssertion
// accepts `(config: { clientId, tokenEndpoint }) => Promise<string>`), so the
// two paths share every line except the signature.
//
// The assertion follows Microsoft's certificate credential format: header
// { alg: 'PS256', typ: 'JWT', 'x5t#S256': <SHA-256 thumbprint> } (or RS256
// with x5t when the registration still holds a SHA-1 thumbprint), and claims
// aud = token endpoint, iss = sub = client id, a fresh jti, and a ten-minute
// lifetime.

import { constants, createHash, createPrivateKey, randomUUID, sign as cryptoSign, type KeyObject } from 'node:crypto';

import { isProductionAppEnv } from '@/lib/appEnv';
import { requireReaderCapability, type ReaderCapability } from '@/lib/discovery/source/capability';
import { normalizeThumbprint, parseKeyVaultKeyId } from '@/lib/graph/registration';

// The pure registration checks live outside the reader directory, so the
// registration script can use them without reaching a reader (#262 thread T2).
export { normalizeThumbprint, parseKeyVaultKeyId };

export type AssertionAlgorithm = 'PS256' | 'RS256';

export interface CertificateSource {
  readonly kind: 'envPem' | 'keyVault';
  /** Hex thumbprint of the certificate uploaded to the app registration. */
  readonly thumbprint: string;
  readonly algorithm: AssertionAlgorithm;
  /** Signs the JWT signing input (header.payload) and returns the raw signature. */
  sign(signingInput: Buffer): Promise<Buffer>;
}

export function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** A SHA-256 thumbprint (64 hex) signs PS256 with x5t#S256; a SHA-1 one (40 hex) RS256 with x5t. */
export function algorithmForThumbprint(thumbprint: string): AssertionAlgorithm {
  const hex = normalizeThumbprint(thumbprint);
  return hex.length === 64 ? 'PS256' : 'RS256';
}

export type AssertionClaims = {
  clientId: string;
  tokenEndpoint: string;
  /** Seconds since the epoch; defaults to now. */
  now?: number;
  jti?: string;
  lifetimeSeconds?: number;
};

/** Builds and signs a client assertion JWT with the given certificate source. */
export async function buildClientAssertion(source: CertificateSource, claims: AssertionClaims): Promise<string> {
  const thumbprint = Buffer.from(normalizeThumbprint(source.thumbprint), 'hex');
  const header =
    source.algorithm === 'PS256'
      ? { alg: 'PS256', typ: 'JWT', 'x5t#S256': base64Url(thumbprint) }
      : { alg: 'RS256', typ: 'JWT', x5t: base64Url(thumbprint) };
  const now = claims.now ?? Math.floor(Date.now() / 1000);
  const payload = {
    aud: claims.tokenEndpoint,
    iss: claims.clientId,
    sub: claims.clientId,
    jti: claims.jti ?? randomUUID(),
    nbf: now,
    iat: now,
    exp: now + (claims.lifetimeSeconds ?? 600),
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = await source.sign(Buffer.from(signingInput, 'utf8'));
  return `${signingInput}.${base64Url(signature)}`;
}

// ── envPem ───────────────────────────────────────────────────────────────────

/** Demands the reader capability (#262): a signing credential is built only behind the guard. */
export function envPemCertificateSource(
  capability: ReaderCapability,
  options: { pem: string; thumbprint: string },
): CertificateSource {
  requireReaderCapability(capability);
  let key: KeyObject;
  try {
    key = createPrivateKey(options.pem);
  } catch {
    // Never echo the input: it is key material.
    throw new Error('The reader certificate key is not a readable PEM private key');
  }
  const thumbprint = normalizeThumbprint(options.thumbprint);
  const algorithm = algorithmForThumbprint(thumbprint);
  return {
    kind: 'envPem',
    thumbprint,
    algorithm,
    async sign(signingInput) {
      return algorithm === 'PS256'
        ? cryptoSign('sha256', signingInput, {
            key,
            padding: constants.RSA_PKCS1_PSS_PADDING,
            saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
          })
        : cryptoSign('sha256', signingInput, key);
    },
  };
}

// ── keyVault ─────────────────────────────────────────────────────────────────

export const KEY_VAULT_API_VERSION = '7.4';

export type KeyVaultDeps = {
  /** A bearer token for https://vault.azure.net (the worker's managed identity). */
  getVaultToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
};

/** Demands the reader capability, like envPemCertificateSource. */
export function keyVaultCertificateSource(
  capability: ReaderCapability,
  options: { keyId: string; thumbprint: string } & KeyVaultDeps,
): CertificateSource {
  requireReaderCapability(capability);
  const keyUrl = parseKeyVaultKeyId(options.keyId);
  const thumbprint = normalizeThumbprint(options.thumbprint);
  const algorithm = algorithmForThumbprint(thumbprint);
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    kind: 'keyVault',
    thumbprint,
    algorithm,
    async sign(signingInput) {
      const digest = createHash('sha256').update(signingInput).digest();
      const token = await options.getVaultToken();
      const res = await fetchImpl(`${keyUrl.toString()}/sign?api-version=${KEY_VAULT_API_VERSION}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ alg: algorithm, value: base64Url(digest) }),
      });
      if (!res.ok) {
        throw new Error(`Key Vault sign failed: ${res.status}`);
      }
      const body = (await res.json()) as { value?: unknown };
      if (typeof body.value !== 'string' || body.value.length === 0) {
        throw new Error('Key Vault sign returned no signature');
      }
      return Buffer.from(body.value, 'base64url');
    },
  };
}

/**
 * The managed identity's Key Vault token, through MSAL's managed identity
 * client (Azure Container Apps sets IDENTITY_ENDPOINT / IDENTITY_HEADER).
 * AZURE_CLIENT_ID selects a user-assigned identity.
 */
export function managedIdentityVaultToken(
  capability: ReaderCapability,
  env: NodeJS.ProcessEnv = process.env,
): () => Promise<string> {
  requireReaderCapability(capability);
  let app: import('@azure/msal-node').ManagedIdentityApplication | null = null;
  return async () => {
    if (!app) {
      const { ManagedIdentityApplication } = await import('@azure/msal-node');
      const clientId = env.AZURE_CLIENT_ID?.trim();
      app = new ManagedIdentityApplication(
        clientId ? { managedIdentityIdParams: { userAssignedClientId: clientId } } : {},
      );
    }
    const result = await app.acquireToken({ resource: 'https://vault.azure.net' });
    return result.accessToken;
  };
}

// ── From a registration's reference ─────────────────────────────────────────

export type CertificateSourceDeps = {
  env?: NodeJS.ProcessEnv;
  getVaultToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
};

/** Resolves graph_reader_registrations.cert_secret_ref to a CertificateSource. Demands the reader capability. */
export function certificateSourceFromRef(
  capability: ReaderCapability,
  ref: string | null,
  thumbprint: string | null,
  deps: CertificateSourceDeps = {},
): CertificateSource {
  requireReaderCapability(capability);
  if (!ref) throw new Error('The reader registration has no cert_secret_ref');
  if (!thumbprint) throw new Error('The reader registration has no cert_thumbprint');
  if (/-----BEGIN/.test(ref)) {
    throw new Error('cert_secret_ref must name a secret, never hold key material');
  }
  const env = deps.env ?? process.env;

  if (ref.startsWith('keyvault:')) {
    return keyVaultCertificateSource(capability, {
      keyId: ref.slice('keyvault:'.length),
      thumbprint,
      getVaultToken: deps.getVaultToken ?? managedIdentityVaultToken(capability, env),
      fetchImpl: deps.fetchImpl,
    });
  }
  if (ref.startsWith('env:')) {
    // The private key never sits in the process environment in production.
    if (isProductionAppEnv(env)) throw new Error('env: certificate references are refused in production');
    const name = ref.slice('env:'.length);
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('cert_secret_ref env: must name an environment variable');
    const pem = env[name];
    if (!pem) throw new Error(`The reader certificate key variable ${name} is not set`);
    return envPemCertificateSource(capability, { pem: pem.replace(/\\n/g, '\n'), thumbprint });
  }
  throw new Error('cert_secret_ref must start with keyvault: or env:');
}
