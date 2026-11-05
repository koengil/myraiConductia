// The ECS task-role credential supplier for workload identity federation (#344, design R4).
// google-auth-library 11.1.0 reads AWS credentials from env keys or EC2 IMDS
// only; a Fargate task has neither, and its library README names a custom
// AwsSecurityCredentialsSupplier as the Fargate path. This is that supplier:
// it reads the task role's credentials from the ECS container endpoint and
// hands them to AwsClient (credentials.ts), which signs the GetCallerIdentity
// request Google's STS verifies. It never reaches anything but the one fixed
// origin, and no credential value ever enters an error message.

import type { AwsSecurityCredentials, AwsSecurityCredentialsSupplier } from 'google-auth-library';

type Env = Record<string, string | undefined>;

/** The ECS container credentials endpoint. Fargate serves the task role here and nowhere else. */
const ECS_CREDENTIALS_ORIGIN = 'http://169.254.170.2';
const ECS_CREDENTIALS_PATH_PREFIX = '/v2/credentials/';
const FETCH_TIMEOUT_MS = 5_000;
/** The credentials document is about 1.5 KiB; anything past this is refused before it is parsed. */
const MAX_BODY_BYTES = 16 * 1024;
/** Task-role credentials last about 6 h; refresh well before they lapse. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** An AWS region id. It is spliced into the STS host name, so nothing else is accepted. */
const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;

/** AWS_CONTAINER_CREDENTIALS_RELATIVE_URI is present: the process runs as an ECS task with a task role. */
export function isEcsTask(env: Env): boolean {
  return Boolean(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI?.trim());
}

/**
 * The only place the credentials URL is built and checked. Built with the URL
 * parser against the fixed origin, never by concatenation, then refused unless
 * the origin is exactly the ECS endpoint, the normalised path is under
 * /v2/credentials/ and no userinfo is present.
 */
export function ecsCredentialsUrl(relativeUri: string): URL {
  let url: URL;
  try {
    url = new URL(relativeUri, ECS_CREDENTIALS_ORIGIN);
  } catch {
    throw new Error('ECS credentials: refusing an unexpected credentials URI');
  }
  if (
    url.origin !== ECS_CREDENTIALS_ORIGIN ||
    url.username !== '' ||
    url.password !== '' ||
    !url.pathname.startsWith(ECS_CREDENTIALS_PATH_PREFIX) ||
    url.pathname.length === ECS_CREDENTIALS_PATH_PREFIX.length
  ) {
    throw new Error('ECS credentials: refusing an unexpected credentials URI');
  }
  return url;
}

type CachedCredentials = { credentials: AwsSecurityCredentials; refreshAt: number };

export type EcsSupplierOptions = {
  now?: () => number;
  /** The per-request timeout. Tests shorten it; the worker uses the 5 s default. */
  timeoutMs?: number;
};

/** The body as text, read no further than MAX_BODY_BYTES; a longer body is refused. */
async function cappedBody(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error('ECS credentials: the response is too large');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('ECS credentials: the response is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`ECS credentials: the response has no ${field}`);
  }
  return value;
}

/**
 * The supplier AwsClient calls for the region and the task role's credentials.
 * AwsClient does not cache supplier results, so this does: one fetch in flight
 * at a time, and the result reused until five minutes before it expires.
 */
export function ecsCredentialsSupplier(
  env: Env,
  fetchImpl: typeof fetch = fetch,
  options: EcsSupplierOptions = {},
): AwsSecurityCredentialsSupplier {
  // Fargate never sets the full URI form. It can point anywhere, so it is refused, not ignored.
  if (env.AWS_CONTAINER_CREDENTIALS_FULL_URI?.trim()) {
    throw new Error('ECS credentials: AWS_CONTAINER_CREDENTIALS_FULL_URI is refused; Fargate uses the relative URI');
  }
  const relativeUri = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI?.trim();
  if (!relativeUri) throw new Error('ECS credentials: AWS_CONTAINER_CREDENTIALS_RELATIVE_URI is not set');
  // Checked now, so a bad URI fails at startup and before any request.
  const url = ecsCredentialsUrl(relativeUri);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;

  let cached: CachedCredentials | null = null;
  let inFlight: Promise<CachedCredentials> | null = null;

  async function fetchCredentials(): Promise<CachedCredentials> {
    let res: Response;
    try {
      // redirect 'error': a redirect never leaves the fixed origin.
      res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    } catch (error) {
      // The class name only (TimeoutError, TypeError, ...); a message could quote anything.
      const name = (error as { name?: unknown } | null)?.name;
      throw new Error(`ECS credentials: the endpoint request failed (${typeof name === 'string' ? name : 'unknown'})`);
    }
    if (!res.ok) throw new Error(`ECS credentials: the endpoint answered ${res.status}`);
    const text = await cappedBody(res);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error('ECS credentials: the response is not JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('ECS credentials: the response is not an object');
    }
    const record = body as Record<string, unknown>;
    const accessKeyId = requiredString(record, 'AccessKeyId');
    const secretAccessKey = requiredString(record, 'SecretAccessKey');
    const token = requiredString(record, 'Token');
    const expiresAt = Date.parse(requiredString(record, 'Expiration'));
    if (!Number.isFinite(expiresAt)) throw new Error('ECS credentials: the Expiration is not a time');
    if (expiresAt <= now()) throw new Error('ECS credentials: the credentials have already expired');
    return { credentials: { accessKeyId, secretAccessKey, token }, refreshAt: expiresAt - REFRESH_MARGIN_MS };
  }

  return {
    async getAwsRegion(): Promise<string> {
      const region = (env.AWS_REGION ?? env.AWS_DEFAULT_REGION)?.trim();
      if (!region) throw new Error('ECS credentials: neither AWS_REGION nor AWS_DEFAULT_REGION is set');
      if (!REGION_RE.test(region)) throw new Error('ECS credentials: the AWS region is not a region id');
      return region;
    },
    async getAwsSecurityCredentials(): Promise<AwsSecurityCredentials> {
      if (cached && cached.refreshAt > now()) return cached.credentials;
      inFlight ??= fetchCredentials().finally(() => {
        inFlight = null;
      });
      cached = await inFlight;
      return cached.credentials;
    },
  };
}
