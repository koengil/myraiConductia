import { readFileSync } from 'node:fs';
import { AwsClient, GoogleAuth, type AwsClientOptions } from 'google-auth-library';

import { isProductionAppEnv } from '@/lib/appEnv';
import { DIRECTORY_SCOPES, GOOGLE_TOOL_SCOPE } from '@/lib/constants/googleReader';
import { keyMaterialProblems } from '@/lib/secrets/keyMaterial';

import { ecsCredentialsSupplier, isEcsTask } from './awsContainerCredentials';

type Env = Record<string, string | undefined>;
type CredentialJson = { type?: string; credential_source?: { environment_id?: unknown } } & Record<string, unknown>;

const ALLOWED_TYPES = new Set(['external_account', 'impersonated_service_account', 'authorized_user']);
const CALLER_VARIABLE = 'GOOGLE_APPLICATION_CREDENTIALS';
const DIRECTORY_VARIABLE = 'GOOGLE_DIRECTORY_CREDENTIALS';

/** Reads and checks a credential file; returns its parsed JSON for the client selection. */
function loadKeylessCredentialFile(path: string, env: Env, variable: string): CredentialJson {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as CredentialJson;
  const problems = keyMaterialProblems(raw);
  if (problems.length > 0) {
    throw new Error(`${variable} ${problems.join(', ')}; use workload identity federation or impersonated ADC`);
  }
  if (!raw.type || !ALLOWED_TYPES.has(raw.type)) {
    throw new Error(`${variable} type ${String(raw.type)} is not allowed`);
  }
  if (raw.type === 'authorized_user' && isProductionAppEnv(env)) {
    throw new Error('User credentials are refused in production; use workload identity federation');
  }
  return raw;
}

/** The worker's own identity: a WIF external-account config (deployed) or
 * gcloud ADC impersonating the caller SA (a developer's machine). Never a
 * service-account key (R5, #259 acceptance). */
export function assertKeylessCredentialFile(path: string, env: Env = process.env, variable = CALLER_VARIABLE): void {
  loadKeylessCredentialFile(path, env, variable);
}

/** A workload identity federation config whose subject token comes from AWS (environment_id aws1). */
export function isAwsExternalAccount(json: CredentialJson): boolean {
  const environmentId = json.credential_source?.environment_id;
  return json.type === 'external_account' && typeof environmentId === 'string' && /^aws/i.test(environmentId);
}

export type CallerTokenSource = () => Promise<string>;

/** The worker's own token (WIF / STS on the hosted worker): a hung exchange fails the job, not the source's hour. */
export const GOOGLE_CALLER_TOKEN_TIMEOUT_MS = 15_000;

/**
 * A caller token source that rejects with a TimeoutError DOMException (the name errorSummary maps to "Request timed
 * out"; the reader pass mapping to request_timeout is planned in the reader-liveness stack, #409 1/3) when the
 * credential call outlives its deadline. The call itself is not cancelled (GoogleAuth takes no signal); its late
 * result is dropped.
 */
export function boundedCallerToken(
  get: () => Promise<string | null | undefined>,
  timeoutMs: number = GOOGLE_CALLER_TOKEN_TIMEOUT_MS,
): CallerTokenSource {
  return async () => {
    const signal = AbortSignal.timeout(timeoutMs);
    const token = await new Promise<string | null | undefined>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      get().then(resolve, reject);
    });
    if (!token) throw new Error('No caller token from the Google credential');
    return token;
  };
}

/**
 * One token source over one keyless credential file (#344, design R4).
 * - An AWS WIF config inside an ECS task: AwsClient with the ECS task-role
 *   supplier, because the library cannot read the container endpoint itself.
 *   The config's credential_source is dropped; the supplier replaces it.
 * - An AWS WIF config in production outside ECS: refused, since the library's
 *   own AWS path would fall back to env keys or IMDS.
 * - Anything else (laptop ADC, impersonated SA, a non-AWS WIF config):
 *   GoogleAuth over the file, unchanged.
 */
function tokenSourceForFile(
  path: string,
  env: Env,
  scopes: string[],
  variable: string,
  timeoutMs: number = GOOGLE_CALLER_TOKEN_TIMEOUT_MS,
): CallerTokenSource {
  const json = loadKeylessCredentialFile(path, env, variable);
  if (isAwsExternalAccount(json) && isEcsTask(env)) {
    const config: Record<string, unknown> = { ...json };
    delete config.credential_source;
    // The file's fields (audience, token URL, impersonation) as the library reads them; it validates them itself.
    const options = {
      ...config,
      aws_security_credentials_supplier: ecsCredentialsSupplier(env),
      scopes,
    } as unknown as AwsClientOptions;
    const client = new AwsClient(options);
    return boundedCallerToken(async () => {
      const { token } = await client.getAccessToken();
      if (!token) throw new Error(`No token from the ${variable} credential`);
      return token;
    }, timeoutMs);
  }
  if (isAwsExternalAccount(json) && isProductionAppEnv(env)) {
    throw new Error('An AWS workload identity config in production needs the ECS container credentials endpoint');
  }
  const auth = new GoogleAuth({ keyFile: path, scopes });
  return boundedCallerToken(async () => {
    const token = await auth.getAccessToken();
    if (!token) throw new Error(`No token from the ${variable} credential`);
    return token;
  }, timeoutMs);
}

/** Overrides for tests: the credential call's deadline (default GOOGLE_CALLER_TOKEN_TIMEOUT_MS). */
export type TokenSourceOptions = { timeoutMs?: number };

export function createCallerTokenSource(env: Env = process.env, options: TokenSourceOptions = {}): CallerTokenSource {
  const path = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!path) throw new Error('GOOGLE_APPLICATION_CREDENTIALS must point at .secrets/google/worker-credentials.json');
  return tokenSourceForFile(path, env, [GOOGLE_TOOL_SCOPE.IAM], CALLER_VARIABLE, options.timeoutMs);
}

/**
 * The directory identity's own token (#344, design R5), from the kit's
 * directory config, which impersonates the directory service account. The
 * token is used as it comes; no generateAccessToken of our own. Unset means
 * today's path: the group mirror asks IAM Credentials with the caller token.
 */
export function createDirectoryTokenSource(env: Env = process.env, options: TokenSourceOptions = {}): CallerTokenSource | null {
  const path = env.GOOGLE_DIRECTORY_CREDENTIALS?.trim();
  if (!path) return null;
  return tokenSourceForFile(path, env, [...DIRECTORY_SCOPES], DIRECTORY_VARIABLE, options.timeoutMs);
}
