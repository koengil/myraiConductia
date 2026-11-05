// @vitest-environment node
// Every model call the app makes leaves through the ZDR AI Gateway client (postGatewayMessages), which is the
// only place the zero-data-retention, Anthropic-only body is built. This fence keeps the direct Anthropic path
// from coming back: a request to api.anthropic.com, or a read of the direct-API credentials, outside the one
// offline recorder that still needs them (an owner-run synthetic-corpus tool, never imported by src/ or
// worker/). It also keeps every other model host and SDK out, and the ZDR body field inside the client. Plain text matching (comments count), so a quoted URL or a renamed
// import cannot slip past. Each rule also asserts that every file on its allow-list still matches, so an
// allow-list entry that goes stale fails instead of quietly widening the fence.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { GATEWAY_MESSAGES_URL, postGatewayMessages } from '@/lib/modelGateway/gatewayClient';

const ROOTS = ['src', 'worker', 'scripts'];

const RECORDER = 'scripts/discovery/lib/anthropicDirect.ts';
const CLIENT = 'src/lib/modelGateway/gatewayClient.ts';
const JEV = 'src/lib/ai/jev.ts';
// The live ZDR probe: its check (b) is the one raw gateway request outside the client (ZDR on, no `only`).
const PROBE = 'scripts/ai/zdr-probe.ts';

// Model hosts and SDKs nothing may name: every model call goes through the gateway client.
const OTHER_MODEL_EGRESS = [
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'aiplatform.googleapis.com',
  'bedrock-runtime',
  'api.mistral.ai',
  'api.cohere',
  'api.groq.com',
  'openrouter.ai',
  'api.together',
  'api.voyageai.com',
  'api.deepseek.com',
  'api.x.ai',
  '@anthropic-ai/',
  '@ai-sdk/',
  '@google/genai',
  '@google/generative-ai',
  '@aws-sdk/client-bedrock',
];

interface Rule {
  /** What the text names. */
  readonly token: string;
  /** The only repo-relative files that may contain it. */
  readonly allowed: readonly string[];
}

const RULES: readonly Rule[] = [
  // The direct Anthropic endpoint. Only the owner-run synthetic-corpus recorder (T2's fallback) calls it.
  { token: 'api.anthropic.com', allowed: [RECORDER] },
  // The gateway endpoint: the app client, and the Jev eval script, which calls /v1/evaluate.
  { token: 'ai-gateway.vercel.sh', allowed: [CLIENT, JEV] },
  // The direct-API credentials. The recorder reads them; its entry point documents them. The AI PR reviewer
  // (dev tooling that reads code diffs, never bank content) passes the key to Claude Code as its fallback credential.
  { token: 'ANTHROPIC_API_KEY', allowed: [RECORDER, 'scripts/discovery/record-extract-replies.ts', 'scripts/ai-review/pipeline.ts'] },
  { token: 'ANTHROPIC_WORKSPACE_ID', allowed: [RECORDER] },
  // The direct recorder is reachable only from its own entry point: never from src/ or worker/.
  { token: 'anthropicDirect', allowed: [RECORDER, 'scripts/discovery/record-extract-replies.ts'] },
  // The ZDR body field is built in the client (and Jev's own evaluate body), never passed in by a caller.
  // The probe is the one named exception: it builds an unrestricted ZDR body to prove the flag is enforced.
  { token: 'zeroDataRetention', allowed: [CLIENT, JEV, PROBE] },
  { token: 'providerOptions', allowed: [CLIENT, JEV, PROBE] },
  // The Messages URL constant: the client, its re-export, and the probe's raw request. Nothing else builds one.
  { token: 'GATEWAY_MESSAGES_URL', allowed: [CLIENT, 'src/lib/modelGateway/transports.ts', PROBE] },
  ...OTHER_MODEL_EGRESS.map((token) => ({ token, allowed: [] })),
];

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : files(p)) : /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(n) ? [p] : [];
  });

const asRepoPath = (p: string) => relative(process.cwd(), p).split(sep).join('/');

/** `path` is repo-relative with forward slashes; `text` is the source. */
function offences(path: string, text: string): string[] {
  return RULES.filter((r) => text.includes(r.token) && !r.allowed.includes(path)).map(
    (r) => `${path}: names ${r.token}, ${r.allowed.length ? `allowed only in ${r.allowed.join(', ')}` : 'allowed nowhere'}`,
  );
}

describe('model traffic leaves through the AI Gateway client only', () => {
  const sources = ROOTS.flatMap((r) => files(join(process.cwd(), r))).map((p) => ({
    path: asRepoPath(p),
    text: readFileSync(p, 'utf8'),
  }));

  it('no source, worker or script file names a direct Anthropic endpoint or credential outside its allow-list', () => {
    expect(sources.flatMap((s) => offences(s.path, s.text))).toEqual([]);
  });

  it.each(RULES.map((r) => [r.token, r] as const))('every allow-list entry for %s still matches', (_token, rule) => {
    const stale = rule.allowed.filter((path) => !sources.find((s) => s.path === path)?.text.includes(rule.token));
    expect(stale).toEqual([]);
  });

  it('flags each token in a file that is not on its allow-list', () => {
    for (const { token } of RULES) {
      expect(offences('src/lib/example.ts', `const x = '${token}';`), token).toHaveLength(1);
      expect(offences('worker/example.ts', `// ${token}`), token).toHaveLength(1);
    }
    // Comments and string fragments of the whole URL count.
    expect(offences('src/lib/example.ts', "fetch('https://api.anthropic.com/v1/messages')")).toHaveLength(1);
    expect(offences('src/lib/example.ts', 'process.env.ANTHROPIC_API_KEY')).toHaveLength(1);
  });

  it('accepts a token inside its allow-list and nowhere else', () => {
    expect(offences(RECORDER, "fetch('https://api.anthropic.com/v1/messages', { key: process.env.ANTHROPIC_API_KEY })")).toEqual([]);
    expect(offences(JEV, "const U = 'https://ai-gateway.vercel.sh/v1/evaluate';")).toEqual([]);
    // The recorder may not reach the gateway host, and the Jev script may not name the direct one.
    expect(offences(RECORDER, "const U = 'https://ai-gateway.vercel.sh/v1/messages';")).toHaveLength(1);
    expect(offences(JEV, "const U = 'https://api.anthropic.com/v1/messages';")).toHaveLength(1);
  });

  it('scans JavaScript sources too, not only TypeScript', () => {
    expect(sources.map((s) => s.path)).toEqual(expect.arrayContaining(['scripts/build-email-mark.mjs', 'scripts/e2e-summary.mjs']));
  });

  it('the client builds the ZDR field itself, once, and takes no parameter that could change it', () => {
    const client = sources.find((s) => s.path === CLIENT)!.text;
    expect(client.match(/zeroDataRetention/g)).toEqual(['zeroDataRetention']);
    expect(client).toContain("providerOptions: { gateway: { zeroDataRetention: true, only: ['anthropic'] } }");
  });
});

describe('the body postGatewayMessages sends', () => {
  it('always carries zero data retention with Anthropic as the only provider', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: 'm', content: [] }), { status: 200 }));
    for (const model of ['anthropic/claude-sonnet-5', 'anthropic/claude-haiku-4-5']) {
      await postGatewayMessages({
        feature: 'compliance_screen',
        model,
        system: 's',
        user: 'u',
        maxTokens: 5,
        timeoutMs: 1_000,
        apiKey: 'k',
        fetchImpl,
      });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(url).toBe(GATEWAY_MESSAGES_URL);
      expect(JSON.parse(String(init?.body)).providerOptions).toEqual({
        gateway: { zeroDataRetention: true, only: ['anthropic'] },
      });
    }
  });
});
