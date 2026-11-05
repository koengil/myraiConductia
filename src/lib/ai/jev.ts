// Jev (TypeSafe AI's decision model) as a second opinion on a rule flag (D82,
// proposed). Jev answers typed questions with probabilities instead of text,
// so the caller decides with a threshold. Called through the AI Gateway the
// way modelGateway/transports.ts calls Anthropic: plain fetch, zero data
// retention, one provider only.
//
// Two callers, and only two (tests/jev-single-importer.test.ts):
//   - the send path's second opinion, through the one gated seam
//     src/lib/compliance/secondOpinion.ts (jevCallAllowed: off by default,
//     flag `mail_jev_second_opinion` plus env, and the model gate's decision);
//   - `npm run eval:screening -- --jev`, on the synthetic corpus, on a dev
//     stack only (jevAllowedHere).
// Like the screen and code-name calls (#339), the entry point takes a decision
// minted by modelCallsAllowed for 'mail_send_second_opinion', whose processor
// is Jev's own (JEV_PROCESSOR), and refuses anything else before any fetch
// (tests/model-call-fence.test.ts).
// The classification zone's ESLint fence names this module (Q1).

import { assertModelDecision, type ModelCallDecision } from '@/lib/ai/modelPolicy';

export const JEV_MODEL = 'typesafe-ai/jev';

/**
 * Jev is asked only on a dev stack (NEXT_PUBLIC_APP_ENV=dev), the same bar
 * #339's model gate sets for `--llm`: the corpus is synthetic, and nothing
 * else may reach a new processor this way.
 */
export function jevAllowedHere(env: Record<string, string | undefined> = process.env): boolean {
  return env.NEXT_PUBLIC_APP_ENV?.trim().toLowerCase() === 'dev';
}
export const GATEWAY_EVALUATE_URL = 'https://ai-gateway.vercel.sh/v1/evaluate';
const TIMEOUT_MS = 5_000;
// Jev's state budget is 32K tokens; a field this long is far past any email
// a banker writes, and the cap keeps one crafted body from costing a request.
const FIELD_LIMIT = 32 * 1024;

/** The two risks the rule layer flags, asked as yes/no questions. */
const QUESTIONS = {
  promissory: {
    type: 'boolean',
    instructions:
      'In this email from an M&A banker, does the sender promise or guarantee the recipient a deal outcome, price, valuation, return, role, board seat or closing?',
    criteria: {
      true: 'a commitment about a result the sender cannot control',
      false:
        'logistics, effort, timing or confidentiality commitments, or a figurative or social use of words like promise, guarantee or commit',
    },
  },
  mnpi: {
    type: 'boolean',
    instructions:
      'In this email from an M&A banker, does the sender disclose material non-public information about a deal, or suggest trading on it?',
    criteria: {
      true: 'competing bids, internal valuations, reservation or walk-away prices, board decisions, unannounced transactions or draft financials',
      false:
        'figures from public filings, press releases or published research, process logistics, compliance reminders, or figurative uses of words like board or walk-away',
    },
  },
} as const;

export type JevRead =
  | { ok: true; promissory: number; mnpi: number; costUsd: number | null; latencyMs: number }
  | { ok: false; code: 'withheld' | 'no_key' | 'timeout' | 'http' | 'unreadable'; latencyMs: number };

const capped = (text: string) => (text.length > FIELD_LIMIT ? text.slice(0, FIELD_LIMIT) : text);

function probability(answer: unknown): number | null {
  const p = (answer as { probability?: unknown } | undefined)?.probability;
  return typeof p === 'number' && p >= 0 && p <= 1 ? p : null;
}

/**
 * Jev's read of how likely an email is promissory and how likely it leaks MNPI.
 * Throws on a decision modelCallsAllowed did not mint for
 * 'mail_send_second_opinion'; a withheld one returns 'withheld' with no call.
 */
export async function jevRiskRead(
  email: { subject: string; body: string },
  model: ModelCallDecision,
  opts: { apiKey?: string; fetchImpl?: typeof fetch } = {},
): Promise<JevRead> {
  const decision = assertModelDecision(model, ['mail_send_second_opinion']);
  const apiKey = opts.apiKey ?? process.env.AI_GATEWAY_API_KEY;
  const doFetch = opts.fetchImpl ?? fetch;
  const started = Date.now();
  const fail = (code: 'withheld' | 'no_key' | 'timeout' | 'http' | 'unreadable') => ({
    ok: false as const,
    code,
    latencyMs: Date.now() - started,
  });
  if (!decision.allowed) return fail('withheld');
  if (!apiKey) return fail('no_key');
  const timedOut = (err: unknown) => err instanceof Error && err.name === 'TimeoutError';
  let res: Response;
  try {
    res = await doFetch(GATEWAY_EVALUATE_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: JEV_MODEL,
        state: { subject: capped(email.subject), body: capped(email.body) },
        questions: QUESTIONS,
        providerOptions: { gateway: { zeroDataRetention: true, only: ['typesafe-ai'] } },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return fail(timedOut(err) ? 'timeout' : 'http');
  }
  if (!res.ok) return fail('http');
  let json: { answers?: Record<string, unknown>; providerMetadata?: { gateway?: { cost?: unknown } } };
  try {
    json = await res.json();
  } catch (err) {
    // The timeout also covers reading the body; anything else is a reply we cannot parse.
    return fail(timedOut(err) ? 'timeout' : 'unreadable');
  }
  const promissory = probability(json.answers?.promissory);
  const mnpi = probability(json.answers?.mnpi);
  if (promissory === null || mnpi === null) return fail('unreadable');
  // An absent or blank cost is unknown, not free.
  const rawCost = json.providerMetadata?.gateway?.cost;
  const cost = typeof rawCost === 'string' && rawCost.trim() !== '' ? Number(rawCost) : NaN;
  return {
    ok: true,
    promissory,
    mnpi,
    costUsd: Number.isFinite(cost) ? cost : null,
    latencyMs: Date.now() - started,
  };
}
