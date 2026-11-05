// App-only Graph tokens for the discovery reader (ADR-005): one MSAL
// confidential client per registration, authenticating with a certificate
// assertion. Only src/lib/mailboxAccess/readers.ts reaches this, with the
// reader capability (#262); no Next.js route ever acquires a reader token.
//
// The assertion is built by certificateSource.ts and handed to MSAL through
// its clientAssertion callback, which MSAL calls with the tenant's token
// endpoint whenever it needs a new token. MSAL caches the access token in
// memory per client, so the certificate is used once an hour, not per call.

import { ConfidentialClientApplication, type Configuration, type INetworkModule } from '@azure/msal-node';

import { requireReaderCapability, type ReaderCapability } from '@/lib/discovery/source/capability';
import type { GetGraphToken } from '@/lib/graph/http';
import { buildClientAssertion, type CertificateSource } from './certificateSource';

export const GRAPH_APP_SCOPE = 'https://graph.microsoft.com/.default';
/** A token acquisition, the certificate assertion and MSAL's token request included, ends within this (#409 F4). */
export const GRAPH_TOKEN_TIMEOUT_MS = 15_000;

/** The registration fields token acquisition needs. */
export type ReaderRegistration = {
  tenantId: string;
  msTenantId: string;
  clientId: string;
  certThumbprint: string | null;
  certSecretRef: string | null;
};

export type TokenProviderDeps = {
  certificateSource: CertificateSource;
  /** Tests inject a network module so MSAL never reaches the network. */
  networkClient?: INetworkModule;
  authorityHost?: string;
  /** Defaults to GRAPH_TOKEN_TIMEOUT_MS. */
  timeoutMs?: number;
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readerMsalConfiguration(registration: ReaderRegistration, deps: TokenProviderDeps): Configuration {
  if (!GUID.test(registration.msTenantId)) {
    // A single-tenant registration: never 'common' or 'organizations'.
    throw new Error('The reader registration needs the bank tenant id (a GUID), not a shared authority');
  }
  if (!GUID.test(registration.clientId)) throw new Error('The reader registration client id must be a GUID');
  const host = deps.authorityHost ?? 'https://login.microsoftonline.com';
  return {
    auth: {
      clientId: registration.clientId,
      authority: `${host}/${registration.msTenantId}`,
      clientAssertion: async (config) => {
        if (!config.tokenEndpoint) throw new Error('MSAL gave no token endpoint for the client assertion');
        return buildClientAssertion(deps.certificateSource, {
          clientId: config.clientId,
          tokenEndpoint: config.tokenEndpoint,
        });
      },
    },
    system: deps.networkClient ? { networkClient: deps.networkClient } : undefined,
  };
}

/**
 * A GetGraphToken for one registration, backed by one MSAL client and its
 * cache. Demands the reader capability (#262): a reader token is acquired only
 * behind the guard.
 */
export function createReaderTokenProvider(
  capability: ReaderCapability,
  registration: ReaderRegistration,
  deps: TokenProviderDeps,
): GetGraphToken {
  requireReaderCapability(capability);
  const client = new ConfidentialClientApplication(readerMsalConfiguration(registration, deps));
  const timeoutMs = deps.timeoutMs ?? GRAPH_TOKEN_TIMEOUT_MS;
  return async (options) => {
    // MSAL takes no signal: race it against the deadline, which rejects with a TimeoutError (as boundedCallerToken does for Google).
    const signal = AbortSignal.timeout(timeoutMs);
    const result = await new Promise<Awaited<ReturnType<typeof client.acquireTokenByClientCredential>>>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      client.acquireTokenByClientCredential({ scopes: [GRAPH_APP_SCOPE], skipCache: options?.forceRefresh === true }).then(resolve, reject);
    });
    if (!result?.accessToken) throw new Error('MSAL returned no Graph token');
    return result.accessToken;
  };
}

/**
 * Per-registration providers, so each bank tenant keeps its own MSAL client
 * and token cache for the life of the worker process. A changed thumbprint or
 * secret reference (a certificate rotation) builds a new client.
 */
export class ReaderTokenCache {
  private readonly providers = new Map<string, { fingerprint: string; get: GetGraphToken }>();

  constructor(
    private readonly capability: ReaderCapability,
    private readonly depsFor: (registration: ReaderRegistration) => TokenProviderDeps,
  ) {
    requireReaderCapability(capability);
  }

  forRegistration(registration: ReaderRegistration): GetGraphToken {
    const fingerprint = [
      registration.msTenantId,
      registration.clientId,
      registration.certThumbprint,
      registration.certSecretRef,
    ].join('|');
    const cached = this.providers.get(registration.tenantId);
    if (cached && cached.fingerprint === fingerprint) return cached.get;
    const get = createReaderTokenProvider(this.capability, registration, this.depsFor(registration));
    this.providers.set(registration.tenantId, { fingerprint, get });
    return get;
  }
}
