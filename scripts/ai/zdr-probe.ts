// Live proof that the AI Gateway enforces zero data retention for the key it is
// run with (#462, ADR-0017 decision 6). The owner runs it with the production
// key before AI is turned on for real mail; CI never runs it (no key).
//
//   AI_GATEWAY_API_KEY=… npm run ai:zdr-probe [-- --non-zdr-model <provider/model>]
//
// The prompt is a dummy ("Reply OK", 5 tokens).
//   (a) Through postGatewayMessages, the app's only model client, so with the
//       exact body the screen sends: the configured screen model must answer 200.
//   (b) One raw request, the only one outside the client (the egress fence
//       allows this file by name): ZDR on and NO provider restriction, to a model
//       no ZDR provider serves. It must answer 400 no_providers_available. That
//       proves the gateway enforces the flag itself, not the Anthropic-only list.
// Exit 0 only if both hold. It prints the model ids, the status and the error
// type, never the key and never a reply body.

import { screenGatewayModel } from '../../src/lib/compliance/llm';
import {
  GATEWAY_MESSAGES_URL,
  gatewayErrorType,
  gatewayHeaders,
  postGatewayMessages,
  type GatewayMessagesResult,
} from '../../src/lib/modelGateway/gatewayClient';

/** Served by the gateway without ZDR (it answered 200 with ZDR off on 2026-10-15), by no ZDR provider. */
export const DEFAULT_NON_ZDR_MODEL = 'zai/glm-4.6';

const PROMPT = { system: 'Reply OK.', user: 'Reply OK', maxTokens: 5, timeoutMs: 20_000 };
const PLAN_HAS_NO_ZDR = "key's team plan has no ZDR (Pro or Enterprise needed)";

export type ProbeOutcome = { ok: boolean; lines: string[] };

function describe(r: GatewayMessagesResult): string {
  if (r.ok) return '200';
  return [r.status ?? 'no status', r.errorCode ?? r.code, `(${r.code})`].join(' ');
}

/** (b): ZDR on, no `only`. The reply is reduced to its status and error type here. */
async function sendZdrUnrestricted(
  model: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<{ status: number | null; type: string | null }> {
  try {
    const res = await fetchImpl(GATEWAY_MESSAGES_URL, {
      method: 'POST',
      headers: gatewayHeaders(apiKey),
      body: JSON.stringify({
        model,
        max_tokens: PROMPT.maxTokens,
        system: PROMPT.system,
        messages: [{ role: 'user', content: PROMPT.user }],
        providerOptions: { gateway: { zeroDataRetention: true } },
      }),
      signal: AbortSignal.timeout(PROMPT.timeoutMs),
    });
    if (res.ok) return { status: res.status, type: null };
    const body: unknown = await res.json().catch(() => null);
    return { status: res.status, type: gatewayErrorType(body) };
  } catch {
    return { status: null, type: null };
  }
}

export async function runZdrProbe(opts: {
  apiKey: string | undefined;
  env?: Record<string, string | undefined>;
  nonZdrModel?: string;
  fetchImpl?: typeof fetch;
}): Promise<ProbeOutcome> {
  if (!opts.apiKey) return { ok: false, lines: ['AI_GATEWAY_API_KEY is not set: nothing was sent.'] };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const screenModel = screenGatewayModel(opts.env);
  const nonZdrModel = opts.nonZdrModel ?? DEFAULT_NON_ZDR_MODEL;

  // The screen's own request, so its model_outcome line names the screen.
  const a = await postGatewayMessages({ ...PROMPT, feature: 'compliance_screen', model: screenModel, apiKey: opts.apiKey, fetchImpl });
  const b = await sendZdrUnrestricted(nonZdrModel, opts.apiKey, fetchImpl);
  const aHolds = a.ok;
  const bHolds = b.status === 400 && b.type === 'no_providers_available';
  const lines = [
    `${aHolds ? 'PASS' : 'FAIL'} (a) screen model ${screenModel} with ZDR: ${describe(a)}; expected 200`,
    `${bHolds ? 'PASS' : 'FAIL'} (b) ${nonZdrModel} with ZDR, no provider restriction: ${b.status ?? 'no response'} ${b.type ?? ''}`.trimEnd() +
      '; expected 400 no_providers_available',
  ];
  const planRefused =
    (!a.ok && a.code === 'zdr_unavailable' && a.status === 403) || (b.status === 403 && b.type === 'permission_denied');
  if (planRefused) lines.push(`The gateway refused ZDR: ${PLAN_HAS_NO_ZDR}.`);
  return { ok: aHolds && bHolds, lines };
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf('--non-zdr-model');
  const nonZdrModel = flag >= 0 ? process.argv[flag + 1] : undefined;
  const outcome = await runZdrProbe({ apiKey: process.env.AI_GATEWAY_API_KEY, nonZdrModel });
  for (const line of outcome.lines) console.log(line);
  console.log(outcome.ok ? 'ZDR enforced: both checks hold.' : 'ZDR not proven: keep AI off for real mail.');
  process.exitCode = outcome.ok ? 0 : 1;
}

if (process.argv[1]?.endsWith('zdr-probe.ts')) void main();
