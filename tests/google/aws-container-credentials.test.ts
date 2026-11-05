// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { ecsCredentialsSupplier, ecsCredentialsUrl, isEcsTask } from '@/lib/google/reader/awsContainerCredentials';

import { scripted, type Reply } from './helpers';

// Built from fragments, so no key-shaped literal sits in the repo.
const ACCESS_KEY_ID = 'ASIA' + 'CANARYKEYID0001';
const SECRET = 'canary-' + 'secret-access-key';
const SESSION_TOKEN = 'canary-' + 'session-token';
const RELATIVE_URI = '/v2/credentials/0f8e2b7a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const NOW = Date.parse('2026-10-03T12:00:00Z');
const ECS_ENV = { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: RELATIVE_URI, AWS_REGION: 'us-east-1' };
const CONTEXT = { audience: 'aud', subjectTokenType: 'urn:ietf:params:aws:token-type:aws4_request' } as never;

function credentialsReply(expiration: string, extra: Record<string, unknown> = {}): Reply {
  return {
    status: 200,
    body: {
      RoleArn: 'arn:aws:iam::123456789012:role/conductia-discovery-worker',
      AccessKeyId: ACCESS_KEY_ID,
      SecretAccessKey: SECRET,
      Token: SESSION_TOKEN,
      Expiration: expiration,
      ...extra,
    },
  };
}

const IN_SIX_HOURS = new Date(NOW + 6 * 3_600_000).toISOString();

/** Every message on an error, its cause chain included, as one string. */
function messagesOf(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message, String(current.stack ?? ''));
    current = (current as Error & { cause?: unknown }).cause;
  }
  return parts.join('\n');
}

describe('ecsCredentialsUrl', () => {
  it('builds the fixed ECS endpoint URL for a task-role relative URI', () => {
    expect(ecsCredentialsUrl(RELATIVE_URI).href).toBe(`http://169.254.170.2${RELATIVE_URI}`);
  });

  it.each([
    ['a protocol-relative host', '//evil.example/v2/credentials/x'],
    ['an absolute foreign URL', 'http://evil.example/v2/credentials/x'],
    ['an https URL on the right address', 'https://169.254.170.2/v2/credentials/x'],
    ['userinfo before the right host', 'http://user:pass@169.254.170.2/v2/credentials/x'],
    ['a userinfo-shaped relative path', '@evil.example/v2/credentials/x'],
    ['traversal out of /v2/credentials/', '/v2/credentials/../../latest/meta-data'],
    ['encoded traversal', '/v2/credentials/%2e%2e/%2e%2e/latest/meta-data'],
    ['the v1 path', '/v1/credentials/x'],
    ['the bare prefix', '/v2/credentials/'],
    ['a backslash host', '\\\\evil.example/v2/credentials/x'],
    ['an IMDS path', '/latest/meta-data/iam/security-credentials/role'],
  ])('refuses %s', (_label, uri) => {
    expect(() => ecsCredentialsUrl(uri)).toThrow(/refusing an unexpected credentials URI/);
  });
});

describe('isEcsTask', () => {
  it('is true only when the relative URI is set', () => {
    expect(isEcsTask(ECS_ENV)).toBe(true);
    expect(isEcsTask({})).toBe(false);
    expect(isEcsTask({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '  ' })).toBe(false);
    expect(isEcsTask({ AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://127.0.0.1/creds' })).toBe(false);
  });
});

describe('ecsCredentialsSupplier', () => {
  it('refuses a bad relative URI before any fetch', () => {
    const { fetchImpl, calls } = scripted([]);
    for (const uri of ['//evil.example/v2/credentials/x', 'http://evil.example/v2/credentials/x', '/v1/credentials/x']) {
      expect(() =>
        ecsCredentialsSupplier({ ...ECS_ENV, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: uri }, fetchImpl),
      ).toThrow(/refusing an unexpected credentials URI/);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses the full URI form, even beside a good relative URI', () => {
    const { fetchImpl, calls } = scripted([]);
    expect(() =>
      ecsCredentialsSupplier({ ...ECS_ENV, AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials' }, fetchImpl),
    ).toThrow(/FULL_URI is refused/);
    expect(() =>
      ecsCredentialsSupplier({ AWS_REGION: 'us-east-1', AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://evil.example/' }, fetchImpl),
    ).toThrow(/FULL_URI is refused/);
    expect(calls).toHaveLength(0);
  });

  it('refuses when no relative URI is set', () => {
    expect(() => ecsCredentialsSupplier({ AWS_REGION: 'us-east-1' }, scripted([]).fetchImpl)).toThrow(/RELATIVE_URI is not set/);
  });

  it('fetches the task role credentials from the fixed origin, with a timeout and no redirects', async () => {
    const { fetchImpl, calls } = scripted([credentialsReply(IN_SIX_HOURS)]);
    const supplier = ecsCredentialsSupplier(ECS_ENV, fetchImpl, { now: () => NOW });
    expect(await supplier.getAwsSecurityCredentials(CONTEXT)).toEqual({
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET,
      token: SESSION_TOKEN,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`http://169.254.170.2${RELATIVE_URI}`);
    expect(calls[0].init.redirect).toBe('error');
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('caches until five minutes before expiry, then refreshes', async () => {
    let now = NOW;
    const expiresAt = NOW + 60 * 60_000;
    const { fetchImpl, calls } = scripted([
      credentialsReply(new Date(expiresAt).toISOString()),
      credentialsReply(new Date(expiresAt + 6 * 3_600_000).toISOString(), { Token: 'second-token' }),
    ]);
    const supplier = ecsCredentialsSupplier(ECS_ENV, fetchImpl, { now: () => now });
    await supplier.getAwsSecurityCredentials(CONTEXT);
    now = expiresAt - 5 * 60_000 - 1;
    expect((await supplier.getAwsSecurityCredentials(CONTEXT)).token).toBe(SESSION_TOKEN);
    expect(calls).toHaveLength(1);
    now = expiresAt - 5 * 60_000;
    expect((await supplier.getAwsSecurityCredentials(CONTEXT)).token).toBe('second-token');
    expect(calls).toHaveLength(2);
  });

  it('shares one fetch between concurrent callers', async () => {
    const { fetchImpl, calls } = scripted([credentialsReply(IN_SIX_HOURS)]);
    const supplier = ecsCredentialsSupplier(ECS_ENV, fetchImpl, { now: () => NOW });
    const [a, b] = await Promise.all([supplier.getAwsSecurityCredentials(CONTEXT), supplier.getAwsSecurityCredentials(CONTEXT)]);
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
  });

  it('a failed fetch is not cached: the next call asks again', async () => {
    const { fetchImpl, calls } = scripted([{ status: 500, body: {} }, credentialsReply(IN_SIX_HOURS)]);
    const supplier = ecsCredentialsSupplier(ECS_ENV, fetchImpl, { now: () => NOW });
    await expect(supplier.getAwsSecurityCredentials(CONTEXT)).rejects.toThrow(/answered 500/);
    expect((await supplier.getAwsSecurityCredentials(CONTEXT)).token).toBe(SESSION_TOKEN);
    expect(calls).toHaveLength(2);
  });

  it('a hung endpoint is aborted by the timeout', async () => {
    const fetchImpl = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const supplier = ecsCredentialsSupplier(ECS_ENV, fetchImpl, { now: () => NOW, timeoutMs: 20 });
    await expect(supplier.getAwsSecurityCredentials(CONTEXT)).rejects.toThrow(/request failed \(TimeoutError\)/);
  });

  it('a redirect is an error, never followed', async () => {
    const { fetchImpl, calls } = scripted([{ status: 302, headers: { Location: 'http://evil.example/creds' } }]);
    const supplier = ecsCredentialsSupplier(ECS_ENV, fetchImpl, { now: () => NOW });
    await expect(supplier.getAwsSecurityCredentials(CONTEXT)).rejects.toThrow(/answered 302/);
    expect(calls).toHaveLength(1);
  });

  it('a redirect refused by fetch itself surfaces as a failed request', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed: redirect mode is set to error');
    }) as typeof fetch;
    const supplier = ecsCredentialsSupplier(ECS_ENV, fetchImpl, { now: () => NOW });
    await expect(supplier.getAwsSecurityCredentials(CONTEXT)).rejects.toThrow(/request failed \(TypeError\)/);
  });

  it.each([
    ['AccessKeyId missing', { AccessKeyId: undefined }, /no AccessKeyId/],
    ['SecretAccessKey empty', { SecretAccessKey: '' }, /no SecretAccessKey/],
    ['Token not a string', { Token: 42 }, /no Token/],
    ['Expiration missing', { Expiration: undefined }, /no Expiration/],
    ['Expiration not a time', { Expiration: 'soon' }, /not a time/],
    ['Expiration in the past', { Expiration: new Date(NOW - 1_000).toISOString() }, /already expired/],
    ['Expiration exactly now', { Expiration: new Date(NOW).toISOString() }, /already expired/],
  ])('refuses a response with %s', async (_label, patch, message) => {
    const { fetchImpl } = scripted([credentialsReply(IN_SIX_HOURS, patch)]);
    const supplier = ecsCredentialsSupplier(ECS_ENV, fetchImpl, { now: () => NOW });
    const error = await supplier.getAwsSecurityCredentials(CONTEXT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(message);
  });

  it('refuses a response that is not a JSON object', async () => {
    const notJson = (async () => new Response('<html>', { status: 200 })) as typeof fetch;
    await expect(ecsCredentialsSupplier(ECS_ENV, notJson, { now: () => NOW }).getAwsSecurityCredentials(CONTEXT)).rejects.toThrow(
      /not JSON/,
    );
    const { fetchImpl } = scripted([{ status: 200, body: ['x'] }]);
    await expect(ecsCredentialsSupplier(ECS_ENV, fetchImpl, { now: () => NOW }).getAwsSecurityCredentials(CONTEXT)).rejects.toThrow(
      /not an object/,
    );
  });

  it('refuses an oversized body before parsing it, declared or streamed', async () => {
    const big = JSON.stringify({ padding: 'x'.repeat(20_000) });
    const declared = (async () => new Response(big, { status: 200, headers: { 'Content-Length': String(big.length) } })) as typeof fetch;
    await expect(ecsCredentialsSupplier(ECS_ENV, declared, { now: () => NOW }).getAwsSecurityCredentials(CONTEXT)).rejects.toThrow(
      /too large/,
    );
    const chunk = new TextEncoder().encode('x'.repeat(4_096));
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
    });
    const streamed = (async () => new Response(endless, { status: 200 })) as typeof fetch;
    await expect(ecsCredentialsSupplier(ECS_ENV, streamed, { now: () => NOW }).getAwsSecurityCredentials(CONTEXT)).rejects.toThrow(
      /too large/,
    );
    expect(pulls).toBeLessThan(10); // stopped at the cap, never read to the end
  });

  it('never puts key material into an error', async () => {
    const failures: Array<Promise<unknown>> = [];
    for (const patch of [{ AccessKeyId: '' }, { Token: 7 }, { Expiration: new Date(NOW - 1).toISOString() }, { Expiration: 'x' }]) {
      const { fetchImpl } = scripted([credentialsReply(IN_SIX_HOURS, patch)]);
      failures.push(ecsCredentialsSupplier(ECS_ENV, fetchImpl, { now: () => NOW }).getAwsSecurityCredentials(CONTEXT).catch((e) => e));
    }
    const echoing = (async () => {
      throw new Error(`upstream said ${SECRET} ${SESSION_TOKEN}`);
    }) as typeof fetch;
    failures.push(ecsCredentialsSupplier(ECS_ENV, echoing, { now: () => NOW }).getAwsSecurityCredentials(CONTEXT).catch((e) => e));
    for (const error of await Promise.all(failures)) {
      const text = messagesOf(error);
      expect(text).not.toContain(ACCESS_KEY_ID);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(SESSION_TOKEN);
    }
  });

  it('takes the region from AWS_REGION, then AWS_DEFAULT_REGION, and refuses none or a non-region', async () => {
    const fetchImpl = scripted([]).fetchImpl;
    const base = { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: RELATIVE_URI };
    expect(await ecsCredentialsSupplier({ ...base, AWS_REGION: 'eu-west-2', AWS_DEFAULT_REGION: 'us-east-1' }, fetchImpl).getAwsRegion(CONTEXT)).toBe(
      'eu-west-2',
    );
    expect(await ecsCredentialsSupplier({ ...base, AWS_DEFAULT_REGION: 'us-gov-west-1' }, fetchImpl).getAwsRegion(CONTEXT)).toBe(
      'us-gov-west-1',
    );
    await expect(ecsCredentialsSupplier(base, fetchImpl).getAwsRegion(CONTEXT)).rejects.toThrow(/neither AWS_REGION/);
    // The region is spliced into the STS host, so a host-shaped value is refused.
    await expect(
      ecsCredentialsSupplier({ ...base, AWS_REGION: 'evil.example/x' }, fetchImpl).getAwsRegion(CONTEXT),
    ).rejects.toThrow(/not a region id/);
  });
});
