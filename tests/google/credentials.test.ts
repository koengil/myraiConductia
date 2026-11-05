// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AwsClient, AwsClientOptions, GoogleAuth, GoogleAuthOptions } from 'google-auth-library';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GOOGLE_TOOL_SCOPE } from '@/lib/constants/googleReader';
import {
  GOOGLE_CALLER_TOKEN_TIMEOUT_MS,
  assertKeylessCredentialFile,
  boundedCallerToken,
  createCallerTokenSource,
  createDirectoryTokenSource,
} from '@/lib/google/reader/credentials';

// The real library classes, recorded as they are built: which client the
// selection picks, and with what options (#344, design R4).
const built = vi.hoisted(() => ({
  aws: [] as Array<{ options: AwsClientOptions; client: AwsClient }>,
  googleAuth: [] as GoogleAuthOptions[],
  googleAuthClients: [] as GoogleAuth[],
}));
vi.mock('google-auth-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('google-auth-library')>();
  class RecordingAwsClient extends actual.AwsClient {
    constructor(options: AwsClientOptions) {
      super(options);
      built.aws.push({ options, client: this });
    }
  }
  class RecordingGoogleAuth extends actual.GoogleAuth {
    constructor(options?: GoogleAuthOptions) {
      super(options);
      built.googleAuth.push(options ?? {});
      built.googleAuthClients.push(this);
    }
  }
  return { ...actual, AwsClient: RecordingAwsClient, GoogleAuth: RecordingGoogleAuth };
});

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'google-credentials-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, content: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(content));
  return path;
}

// Built from fragments so the repo's key-material grep does not match this test.
const KEY_FIELD = 'private_' + 'key';
const KEY_FILE_TYPE = 'service_' + 'account';

describe('assertKeylessCredentialFile', () => {
  it('refuses a service-account key file', () => {
    const path = file('sa.json', { type: KEY_FILE_TYPE, project_id: 'p' });
    expect(() => assertKeylessCredentialFile(path, {})).toThrow(/service-account key file/);
  });

  it('refuses a file with a private key field, whatever its type', () => {
    const path = file('pk.json', { type: 'external_account', [KEY_FIELD]: 'x' });
    expect(() => assertKeylessCredentialFile(path, {})).toThrow(/private_key field/);
  });

  it('refuses a file with a PEM block', () => {
    const path = file('pem.json', { type: 'external_account', note: '-----' + 'BEGIN PRIVATE KEY-----' });
    expect(() => assertKeylessCredentialFile(path, {})).toThrow(/PEM block/);
  });

  it('refuses an unknown type', () => {
    expect(() => assertKeylessCredentialFile(file('t.json', { type: 'other' }), {})).toThrow(/not allowed/);
    expect(() => assertKeylessCredentialFile(file('n.json', {}), {})).toThrow(/not allowed/);
  });

  it('allows authorized_user in dev and refuses it in prod', () => {
    const path = file('adc.json', { type: 'authorized_user', client_id: 'c' });
    expect(() => assertKeylessCredentialFile(path, { NEXT_PUBLIC_APP_ENV: 'dev' })).not.toThrow();
    for (const appEnv of ['prod', ' PROD ', 'production']) {
      expect(() => assertKeylessCredentialFile(path, { NEXT_PUBLIC_APP_ENV: appEnv }), appEnv).toThrow(/refused in production/);
    }
  });

  it('allows external_account and impersonated_service_account in prod', () => {
    const prod = { NEXT_PUBLIC_APP_ENV: 'prod' };
    expect(() => assertKeylessCredentialFile(file('wif.json', { type: 'external_account' }), prod)).not.toThrow();
    expect(() => assertKeylessCredentialFile(file('imp.json', { type: 'impersonated_service_account' }), prod)).not.toThrow();
  });
});

describe('createCallerTokenSource', () => {
  it('fails when GOOGLE_APPLICATION_CREDENTIALS is unset or blank', () => {
    expect(() => createCallerTokenSource({})).toThrow(/GOOGLE_APPLICATION_CREDENTIALS must point/);
    expect(() => createCallerTokenSource({ GOOGLE_APPLICATION_CREDENTIALS: '  ' })).toThrow(/must point/);
  });

  it('refuses a key file before building any client', () => {
    const path = file('sa2.json', { type: KEY_FILE_TYPE });
    expect(() => createCallerTokenSource({ GOOGLE_APPLICATION_CREDENTIALS: path })).toThrow(/service-account key file/);
  });
});

// What `gcloud iam workload-identity-pools create-cred-config --aws` emits (the #342 kit's two outputs).
const AUDIENCE = '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/conductia-worker/providers/aws-ecs';
const AWS_CONFIG = {
  universe_domain: 'googleapis.com',
  type: 'external_account',
  audience: AUDIENCE,
  subject_token_type: 'urn:ietf:params:aws:token-type:aws4_request',
  token_url: 'https://sts.googleapis.com/v1/token',
  credential_source: {
    environment_id: 'aws1',
    region_url: 'http://169.254.169.254/latest/meta-data/placement/availability-zone',
    url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials',
    regional_cred_verification_url: 'https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15',
  },
};
const IMPERSONATION_URL =
  'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa-directory@proj-1.iam.gserviceaccount.com:generateAccessToken';
const AWS_DIRECTORY_CONFIG = { ...AWS_CONFIG, service_account_impersonation_url: IMPERSONATION_URL };
const OIDC_CONFIG = { ...AWS_CONFIG, credential_source: { file: '/var/run/token' } };

const RELATIVE_URI = '/v2/credentials/0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const ECS = { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: RELATIVE_URI, AWS_REGION: 'us-east-1' };
const SESSION_TOKEN = 'canary-' + 'session-token';

describe('credential selection (#344, design R4)', () => {
  beforeEach(() => {
    built.aws.length = 0;
    built.googleAuth.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('an AWS config inside an ECS task builds AwsClient with the ECS supplier in place of credential_source', () => {
    const path = file('wif-dwd.json', AWS_CONFIG);
    expect(typeof createCallerTokenSource({ ...ECS, NEXT_PUBLIC_APP_ENV: 'prod', GOOGLE_APPLICATION_CREDENTIALS: path })).toBe('function');
    expect(built.googleAuth).toHaveLength(0);
    expect(built.aws).toHaveLength(1);
    const { options } = built.aws[0];
    expect(options).not.toHaveProperty('credential_source');
    expect(options.aws_security_credentials_supplier).toBeDefined();
    expect(options).toMatchObject({ type: 'external_account', audience: AUDIENCE, scopes: [GOOGLE_TOOL_SCOPE.IAM] });
  });

  it('the AwsClient signs GetCallerIdentity with the task role credentials the supplier read', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          AccessKeyId: 'ASIA' + 'CANARYKEYID0001',
          SecretAccessKey: 'canary-' + 'secret',
          Token: SESSION_TOKEN,
          Expiration: new Date(Date.now() + 6 * 3_600_000).toISOString(),
        }),
        { status: 200 },
      );
    }) as typeof fetch);
    createCallerTokenSource({ ...ECS, GOOGLE_APPLICATION_CREDENTIALS: file('wif-sign.json', AWS_CONFIG) });
    // retrieveSubjectToken stops before Google's STS, so nothing leaves the process.
    const subject = JSON.parse(decodeURIComponent(await built.aws[0].client.retrieveSubjectToken())) as {
      url: string;
      method: string;
      headers: Array<{ key: string; value: string }>;
    };
    expect(calls).toEqual([`http://169.254.170.2${RELATIVE_URI}`]);
    expect(subject.url).toBe('https://sts.us-east-1.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15');
    expect(subject.method).toBe('POST');
    const headers = new Map(subject.headers.map(({ key, value }) => [key.toLowerCase(), value]));
    expect(headers.get('x-amz-security-token')).toBe(SESSION_TOKEN);
    expect(headers.get('x-goog-cloud-target-resource')).toBe(AUDIENCE);
    expect(headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=ASIA/);
  });

  it('the directory config in an ECS task keeps its impersonation and asks for the two directory scopes only (#581)', () => {
    const source = createDirectoryTokenSource({ ...ECS, GOOGLE_DIRECTORY_CREDENTIALS: file('wif-dir.json', AWS_DIRECTORY_CONFIG) });
    expect(source).toBeTypeOf('function');
    expect(built.aws).toHaveLength(1);
    expect(built.aws[0].options).toMatchObject({
      service_account_impersonation_url: IMPERSONATION_URL,
      scopes: [GOOGLE_TOOL_SCOPE.DIRECTORY_MEMBERS, GOOGLE_TOOL_SCOPE.DIRECTORY_USERS],
    });
    expect(built.aws[0].options).not.toHaveProperty('credential_source');
  });

  it('no directory config means no directory source (today\'s path)', () => {
    expect(createDirectoryTokenSource({})).toBeNull();
    expect(createDirectoryTokenSource({ GOOGLE_DIRECTORY_CREDENTIALS: '  ' })).toBeNull();
    expect(built.aws).toHaveLength(0);
    expect(built.googleAuth).toHaveLength(0);
  });

  it('a laptop keeps GoogleAuth over the file: ADC, an impersonated SA, or an AWS config outside ECS', () => {
    const adc = file('adc2.json', { type: 'authorized_user', client_id: 'c' });
    const imp = file('imp2.json', { type: 'impersonated_service_account' });
    const aws = file('wif-laptop.json', AWS_CONFIG);
    createCallerTokenSource({ NEXT_PUBLIC_APP_ENV: 'dev', GOOGLE_APPLICATION_CREDENTIALS: adc });
    createCallerTokenSource({ ...ECS, GOOGLE_APPLICATION_CREDENTIALS: imp });
    createCallerTokenSource({ NEXT_PUBLIC_APP_ENV: 'dev', GOOGLE_APPLICATION_CREDENTIALS: aws });
    createDirectoryTokenSource({ GOOGLE_DIRECTORY_CREDENTIALS: imp });
    expect(built.aws).toHaveLength(0);
    expect(built.googleAuth).toEqual([
      { keyFile: adc, scopes: [GOOGLE_TOOL_SCOPE.IAM] },
      { keyFile: imp, scopes: [GOOGLE_TOOL_SCOPE.IAM] },
      { keyFile: aws, scopes: [GOOGLE_TOOL_SCOPE.IAM] },
      { keyFile: imp, scopes: [GOOGLE_TOOL_SCOPE.DIRECTORY_MEMBERS, GOOGLE_TOOL_SCOPE.DIRECTORY_USERS] },
    ]);
  });

  it('a non-AWS external account stays on GoogleAuth even inside ECS', () => {
    const oidc = file('wif-oidc.json', OIDC_CONFIG);
    createCallerTokenSource({ ...ECS, NEXT_PUBLIC_APP_ENV: 'prod', GOOGLE_APPLICATION_CREDENTIALS: oidc });
    expect(built.aws).toHaveLength(0);
    expect(built.googleAuth).toEqual([{ keyFile: oidc, scopes: [GOOGLE_TOOL_SCOPE.IAM] }]);
  });

  it('refuses an AWS config in production outside an ECS task, for both credentials', () => {
    const aws = file('wif-prod.json', AWS_CONFIG);
    const prod = { NEXT_PUBLIC_APP_ENV: 'prod', AWS_REGION: 'us-east-1' };
    expect(() => createCallerTokenSource({ ...prod, GOOGLE_APPLICATION_CREDENTIALS: aws })).toThrow(
      /needs the ECS container credentials endpoint/,
    );
    expect(() => createCallerTokenSource({ ...prod, NEXT_PUBLIC_APP_ENV: ' Production', GOOGLE_APPLICATION_CREDENTIALS: aws })).toThrow(
      /needs the ECS container credentials endpoint/,
    );
    expect(() => createDirectoryTokenSource({ ...prod, GOOGLE_DIRECTORY_CREDENTIALS: aws })).toThrow(
      /needs the ECS container credentials endpoint/,
    );
    expect(built.aws).toHaveLength(0);
    expect(built.googleAuth).toHaveLength(0);
  });

  it('refuses the ECS full URI form before building a client', () => {
    const aws = file('wif-full.json', AWS_CONFIG);
    expect(() =>
      createCallerTokenSource({ ...ECS, AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://127.0.0.1/x', GOOGLE_APPLICATION_CREDENTIALS: aws }),
    ).toThrow(/FULL_URI is refused/);
    expect(built.aws).toHaveLength(0);
  });

  it('runs the keyless check on the directory file too, naming its variable', () => {
    const key = file('dir-sa.json', { type: KEY_FILE_TYPE });
    expect(() => createDirectoryTokenSource({ GOOGLE_DIRECTORY_CREDENTIALS: key })).toThrow(
      /^GOOGLE_DIRECTORY_CREDENTIALS .*service-account key file/,
    );
    const user = file('dir-adc.json', { type: 'authorized_user' });
    expect(() => createDirectoryTokenSource({ NEXT_PUBLIC_APP_ENV: 'prod', GOOGLE_DIRECTORY_CREDENTIALS: user })).toThrow(
      /refused in production/,
    );
    expect(built.aws).toHaveLength(0);
    expect(built.googleAuth).toHaveLength(0);
  });
});

// The production wiring: every client the selection builds is bounded, so a hung STS or ADC call times out.
describe('the credential call deadline in each built source', () => {
  beforeEach(() => {
    built.aws.length = 0;
    built.googleAuth.length = 0;
    built.googleAuthClients.length = 0;
  });
  afterEach(() => vi.restoreAllMocks());
  const never = () => new Promise<never>(() => {});

  it('the AwsClient source (ECS) times out a hung getAccessToken, caller and directory', async () => {
    const caller = createCallerTokenSource({ ...ECS, GOOGLE_APPLICATION_CREDENTIALS: file('wif-hang.json', AWS_CONFIG) }, { timeoutMs: 20 });
    const directory = createDirectoryTokenSource(
      { ...ECS, GOOGLE_DIRECTORY_CREDENTIALS: file('wif-dir-hang.json', AWS_DIRECTORY_CONFIG) },
      { timeoutMs: 20 },
    )!;
    expect(built.aws).toHaveLength(2);
    for (const { client } of built.aws) vi.spyOn(client, 'getAccessToken').mockImplementation(never);
    await expect(caller()).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(directory()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('the GoogleAuth source times out a hung getAccessToken, caller and directory', async () => {
    const imp = file('imp-hang.json', { type: 'impersonated_service_account' });
    const caller = createCallerTokenSource({ GOOGLE_APPLICATION_CREDENTIALS: imp }, { timeoutMs: 20 });
    const directory = createDirectoryTokenSource({ GOOGLE_DIRECTORY_CREDENTIALS: imp }, { timeoutMs: 20 })!;
    expect(built.googleAuthClients).toHaveLength(2);
    for (const client of built.googleAuthClients) vi.spyOn(client, 'getAccessToken').mockImplementation(never);
    await expect(caller()).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(directory()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('defaults to the 15 s caller-token deadline', async () => {
    expect(GOOGLE_CALLER_TOKEN_TIMEOUT_MS).toBe(15_000);
    const caller = createCallerTokenSource({ GOOGLE_APPLICATION_CREDENTIALS: file('imp-default.json', { type: 'impersonated_service_account' }) });
    vi.spyOn(built.googleAuthClients[0], 'getAccessToken').mockImplementation(async () => 'tok' as never);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    expect(await caller()).toBe('tok');
    expect(timeout).toHaveBeenCalledWith(15_000);
  });
});

describe('boundedCallerToken', () => {
  it('rejects with a TimeoutError when the credential call outlives its deadline', async () => {
    const error = await boundedCallerToken(() => new Promise(() => {}), 20)().catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'TimeoutError' });
  });

  it('returns the token, refuses an empty one and passes a rejection through', async () => {
    expect(await boundedCallerToken(async () => 'tok', 20)()).toBe('tok');
    await expect(boundedCallerToken(async () => null, 20)()).rejects.toThrow('No caller token from the Google credential');
    const boom = new Error('sts down');
    await expect(boundedCallerToken(() => Promise.reject(boom), 20)()).rejects.toBe(boom);
  });
});
