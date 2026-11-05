import {
  assertModelDecision,
  modelDecisionRecord,
  type ModelCallDecision,
  type ModelDecisionRecord,
  type ModelPurpose,
  type ModelWithheldReason,
} from '@/lib/ai/modelPolicy';
import { ledgerUsage, type AiCallUsage } from '@/lib/ai/usage';
import { gatewayModelId, postGatewayMessages } from '@/lib/modelGateway/gatewayClient';
import type { ComplianceCheckResult } from '../api/types';
import {
  crossFieldMnpiHold,
  findScreenHits,
  MNPI_FLAG,
  PROMISSORY_FLAG,
  type ScreenHit,
} from './screen';
import {
  LEXICON_AUDIT_CAP_PER_TIER,
  LEXICON_SIGNAL_CAP,
  LEXICON_TIER_SURFACE,
  LEXICON_VERSION,
  findLexiconHits,
  lexiconCategoryName,
  type LexiconHit,
} from './lexicon';
import { REWRITE_PATTERNS } from './rewritePatterns';
import { secondOpinionOn, type SecondOpinionRecord, type SecondOpinionRequest } from './secondOpinion';

/**
 * The LLM escalation layer over the deterministic screen (mode "full").
 *
 * Doctrine (handbook §2): the deterministic screenMessage() rule pack is the
 * compliance control — "a regulator will not accept 'the model decided' as a
 * control". The LLM catches what regex misses (implied guarantees, softened
 * promissory language, subtle MNPI leakage) and may only ESCALATE the verdict:
 *   compliant → hold | blocked,  hold → blocked.
 * A rules-based verdict is never downgraded by this layer (Jev's second
 * opinion, D82, is a separate, off-by-default step). If the LLM is unavailable or
 * returns garbage, the caller keeps the deterministic verdict and the
 * degradation is recorded as llmChecked: false — visible, never silent.
 * llmChecked: false also covers the intentional skip on a rules-based block
 * (severity already maximal): either way it means "the AI did not run".
 *
 * Single Anthropic model, no multi-model routing (v1 decision, 2026-07-02):
 * model from SCREEN_LLM_MODEL, sent through the AI Gateway (zero data
 * retention, Anthropic only) with AI_GATEWAY_API_KEY.
 *
 * The model gate (#339 phase 1): the pass sees a tenant's mail, so both entry
 * points take a ModelCallDecision from modelCallsAllowed (src/lib/ai/
 * modelPolicy.ts) as a required argument, and the raw call is module-private.
 * A withheld decision keeps the deterministic verdict with llmChecked: false
 * and names the reason in llmWithheld.
 */

const DEFAULT_MODEL = 'claude-sonnet-5';

/** The gateway model id the screen sends to: SCREEN_LLM_MODEL, bare or prefixed, else the default. */
export function screenGatewayModel(env: Record<string, string | undefined> = process.env): string {
  return gatewayModelId(env.SCREEN_LLM_MODEL || DEFAULT_MODEL);
}
// 10s silently degraded EXACTLY the hard judgments (live-timed Aug 19: a
// borderline rule-circumvention case took >10s while easy cases answered
// fast) — a timeout that selects against difficult cases is the worst
// failure mode for an escalation layer. Callers set maxDuration to match.
const TIMEOUT_MS = 25_000;
// Room for the full-body rewrite the #158 contract asks for — 512 truncated
// long replies mid-JSON, silently disabling the whole LLM layer.
const MAX_TOKENS = 2048;

const SYSTEM_PROMPT = [
  'You are the pre-send compliance screen of an M&A advisory platform regulated under FINRA and the SEC.',
  'A deterministic rule pack has already run; you are the second pass that catches intent the rules miss:',
  'implied or softened promissory commitments to a counterparty, and subtle MNPI (material non-public information) leakage such as internal valuations, price floors, or unannounced facts.',
  // The front-page (reputational) test — Storm's Aug 3 ask, calibrated to the
  // team's agreed middle ground (2026-08-05): named categories rather than a
  // vague embarrassment standard, an explicit not-a-trigger list, and a hard
  // cap at hold — reputational risk alone never blocks, it summons a human.
  'Additionally, apply the front-page test for reputational risk: escalate when the message contains disparaging or mocking remarks about a client, counterparty, or regulator; boasts about bending or circumventing rules or exploiting a counterparty; profanity or a personal attack directed at a person; or cavalier remarks about confidential information.',
  'Ordinary informal tone, humor without a target, and candid but professionally phrased business judgments are NOT reputational risk.',
  'Reputational risk alone is capped at hold, never blocked.',
  'Judge ONLY the message text you are given. Reply with a single JSON object and nothing else:',
  '{"verdict":"compliant"|"hold"|"blocked","reasons":[string,...],"rewrite":string?,"cause":"mnpi"|"reputational"?,"heat":integer?}',
  'blocked = promissory commitment language that must be rewritten before send.',
  'hold = an MNPI signal or a reputational (front-page) risk that needs review.',
  'compliant = neither. Do not flag ordinary deal logistics. Reasons must be short single sentences.',
  'For a hold verdict, set "cause": "reputational" ONLY when the concern is purely the front-page test; any MNPI signal means "cause": "mnpi".',
  'For hold and blocked verdicts include "rewrite": ONLY the message BODY with the risk issues fixed — change ONLY the language that creates the risk and keep every other sentence verbatim, preserving the sender\'s intent and tone — never echo the subject line or attachment names, and never repeat the body twice.',
  'If the body exceeds roughly 300 words, omit "rewrite" entirely rather than truncating it.',
  'Always include "heat": an integer 0-100 risk read of the message as written (0 = routine logistics, 100 = certain violation).',
  // The firm's rewrite style (#163 slice 3): the §4.3 patterns from the
  // Communications Risk Lexicon travel with every screen, so a suggested
  // rewrite speaks the house vocabulary instead of generic compliance-ese.
  // Principle 2 of the standard rides along: a rewrite preserves truthful
  // substance — never wording that disguises conduct or defeats detection.
  "When you write a rewrite, follow the firm's rewrite doctrine: say the true thing better, never say a false thing quietly.",
  'A rewrite preserves truthful substance; never suggest wording that disguises conduct or defeats detection.',
  'House rewrite patterns (risky phrasing -> safe phrasing): ' +
    REWRITE_PATTERNS.filter((p) => p.send !== null)
      .map((p) => `"${p.instead}" -> "${p.send}"`)
      .join('; ') +
    '.',
  // The no-rewrite list is DERIVED from the data (send: null), never
  // hand-enumerated — a lexicon version bump that adds a fourth
  // no-safe-rewrite pattern must reach the model without a prompt edit.
  'Some messages have NO safe rewrite: ' +
    REWRITE_PATTERNS.filter((p) => p.send === null)
      .map((p) => `"${p.instead}"`)
      .join('; ') +
    '. For those omit "rewrite" and say in a reason that the message should not be sent and the concern escalated instead.',
].join(' ');

/**
 * The system prompt, with the sender's pre-approved terms appended when
 * present. The terms reach here only after server-side validation against the
 * real deterministic hits (outbox route), so no free-form client text can be
 * injected — every listed term is one the rule pack itself matched.
 */
export function systemPrompt(opts?: ScreenOptions): string {
  const parts = [SYSTEM_PROMPT];

  // Lexicon signals (#163): computed server-side by fullScreenFields from the
  // firm's Communications Risk Lexicon — context for judgment, never a
  // verdict. The parent document's own rules travel with the signals. Only
  // the tiers the standard lets an escalate-only judge see (LEXICON_TIER_
  // SURFACE.ai): a Tier-3 "contextual" phrase is analytics evidence, and
  // handing it to the model would be exactly the coaching-on-T3-alone the
  // standard forbids. Each phrase carries its category so the model reasons
  // about the RISK the family describes, not the words.
  const signals = (opts?.lexiconSignals ?? [])
    .filter((s) => LEXICON_TIER_SURFACE[s.tier].ai)
    .slice(0, LEXICON_SIGNAL_CAP);
  if (signals.length > 0) {
    parts.push(
      `The firm's Communications Risk Lexicon (version ${LEXICON_VERSION}) flagged these phrases in the message: ${signals
        .map((s) => `"${s.phrase}" (tier ${s.tier}, ${lexiconCategoryName(s.category)})`)
        .join(', ')}.`,
      'A tier is a ceiling, not an assessment — almost every entry has a legitimate use.',
      'Weigh these as evidence about the message\'s SUBSTANCE (what conduct it enables, conceals, or commits the firm to); never escalate on a phrase match alone, and never lower a verdict because a phrase seems innocent.',
    );
  }

  const terms = (opts?.preApproved ?? []).slice(0, 50);
  if (terms.length === 0) return parts.join(' ');
  return [
    ...parts,
    `The sender explicitly reviewed and chose to keep the following rule-flagged terms: ${terms
      .map((t) => `"${t}"`)
      .join(', ')}.`,
    // Option A (#164 decision 2): the sign-off covers the commitment the kept
    // term ITSELF expresses — its own clause, natural object included — not
    // just its exact words (else the model re-flags the same sentence "beyond
    // the reviewed phrase" and the Keep is theatre, the #185 failure), and
    // not the whole sentence either (else a second promise smuggled into the
    // signed sentence with an "and" rides through — live-probed 3/3 Aug 20).
    'Do not escalate for those terms, nor for the specific commitment a kept term itself expresses — its own clause, including its natural object — that risk is acknowledged and audited.',
    'A sign-off covers ONLY the kept term\'s own commitment: if the same sentence also carries a separate additional commitment (for example a second promise joined by "and"), that additional commitment is NOT covered.',
    'Still escalate for genuinely DISTINCT concerns the sender has not seen: any additional promissory commitment not expressed by a kept term itself, in the same sentence or elsewhere; any reputational (front-page) concern; and any MNPI signal anywhere — a sign-off never clears MNPI or reputational risk.',
  ].join(' ');
}

const VERDICTS = new Set(['compliant', 'hold', 'blocked']);
const SEVERITY: Record<ComplianceCheckResult['verdict'], number> = {
  compliant: 0,
  hold: 1,
  blocked: 2,
};

/** Why a hold verdict held — routes the supervisory path (#158, decision 2). */
export type HoldCause = 'mnpi' | 'reputational';

/** The LLM's own read, with the #158 extras the deterministic layer lacks. */
export type LlmVerdict = ComplianceCheckResult & {
  holdCause?: HoldCause;
  /** Ephemeral 0-100 risk read — DISPLAYED at send time, never persisted. */
  heat?: number;
  /** What the pass cost: model + token counters from the API reply (#109). */
  ai?: AiCallUsage;
};

export type ScreenedVerdict = ComplianceCheckResult & {
  llmChecked: boolean;
  /**
   * Present when verdict is 'hold': 'mnpi' queues for the CCO (no bypass);
   * 'reputational' soft-holds back to the SENDER (modal — decision 2). A
   * deterministic MNPI hold is always 'mnpi'; an LLM hold with no cause
   * label fails CLOSED to 'mnpi' (the queue), never open.
   */
  holdCause?: HoldCause;
  /** The validated sender sign-offs this screen actually applied (#156). */
  preApproved?: string[];
  /** Ephemeral heat from the LLM — read by the soft-hold modal and by the
   *  band derivation (#192); the raw number itself is never stored. */
  heat?: number;
  /** True when `rewrite` is the LLM's rewritten BODY (sendable as-is);
   *  false/absent when it is the rule pack's advisory NOTE — advice to the
   *  sender, never a message body (#192 Risk Patcher). */
  rewriteIsBody?: boolean;
  /**
   * The lexicon signals this screen weighed (#163): the enforced vocabulary
   * VERSION plus every capped hit — audit evidence ("make every alert
   * explainable"), never a verdict input at the rules layer.
   */
  lexicon?: { version: string; signals: LexiconHit[] };
  /** The LLM pass's usage, for the AI spend ledger (#109). Absent when no
   *  pass ran. Never part of the verdict. */
  ai?: AiCallUsage;
  /** The model gate's decision for this screen, carried to the audit row
   *  (#339). A send-as-is replay carries the first screen's decision, from
   *  its signed token. */
  modelDecision: ModelDecisionRecord;
  /** Why the model pass was withheld, when it was. */
  llmWithheld?: ModelWithheldReason;
  /** Jev's second opinion on a rule flag (D82), when the send path asked for
   *  one and it was enabled. Outcome, threshold and lifted reasons only. */
  secondOpinion?: SecondOpinionRecord;
  /** The Jev call's ledger line (D82); absent when nothing was billed. */
  secondOpinionAi?: { model: string; costUsd: number | null };
};

/** The purposes a screen serves: the send, the composer's full screen, the eval. */
const SCREEN_PURPOSES: readonly ModelPurpose[] = ['mail_send_screen', 'mail_screen', 'screening_eval'];

/** The audit fields of a gate decision: the decision, and the reason when withheld. */
function modelAuditFields(
  decision: ModelCallDecision,
): Pick<ScreenedVerdict, 'modelDecision' | 'llmWithheld'> {
  return {
    modelDecision: modelDecisionRecord(decision),
    ...(decision.allowed ? {} : { llmWithheld: decision.reason }),
  };
}

/** Escalate-only merge of the deterministic result with the LLM pass. The
 *  caller adds the gate decision. */
export function mergeVerdicts(
  deterministic: ComplianceCheckResult,
  llm: ComplianceCheckResult | null,
): Omit<ScreenedVerdict, 'modelDecision'> {
  if (!llm) return { ...deterministic, llmChecked: false };
  if (SEVERITY[llm.verdict] <= SEVERITY[deterministic.verdict]) {
    return { ...deterministic, llmChecked: true };
  }
  return {
    verdict: llm.verdict,
    reasons: [...deterministic.reasons, ...llm.reasons],
    rewrite: llm.rewrite ?? deterministic.rewrite,
    llmChecked: true,
  };
}

export type ScreenOptions = {
  /**
   * Terms the SENDER explicitly reviewed and kept in the composer (#155/#156),
   * already validated against the real Layer 1 hits (fullScreenFields does the
   * intersection) — never raw client input. The AI is told a sign-off covers
   * the commitment the kept term's SENTENCE expresses, not just its exact
   * words (#185) — and never MNPI. Verdict effect (decision 2, option A —
   * triage #164, Aug 13): a fully signed-off PROMISSORY set passes the
   * deterministic gate (the override is audited by the caller); an MNPI
   * signal ignores sign-offs entirely — the queue has no bypass.
   */
  preApproved?: string[];
  /**
   * Lexicon hits computed by fullScreenFields over the same text the model
   * reads (#163) — server-derived, never client input. Context only: the
   * model is told a tier is a ceiling and substance decides.
   */
  lexiconSignals?: LexiconHit[];
};

/**
 * The full (send-time) screen: deterministic first, then the LLM pass.
 * A rules-based block skips the LLM — maximum severity is already reached and
 * is never downgraded. The skip is recorded honestly: llmChecked stays false,
 * so the audit never claims an AI check that did not run. So does a withheld
 * model decision (#339): the deterministic verdict stands, with llmWithheld.
 */
export async function fullScreen(
  text: string,
  model: ModelCallDecision,
  opts?: FullScreenOptions,
): Promise<ScreenedVerdict> {
  return fullScreenFields([text], model, opts);
}

export type FullScreenOptions = {
  /**
   * RAW sender sign-off claims from the client (#155/#156). Validation lives
   * HERE, not in the caller: every claim is intersected with the hits the
   * rule pack itself recomputes over these fields, so an unvalidated path to
   * the AI prompt cannot be expressed. The validated list rides back on the
   * result as `preApproved` for the caller's audit record.
   */
  claims?: string[];
  /**
   * The send path's Jev second opinion (D82): consulted only when the rules
   * leave a flag after sign-offs, and only when its gate allows. Absent (the
   * /api/v1/screen route, the eval) = never consulted.
   */
  secondOpinion?: SecondOpinionRequest;
};

/**
 * Field-aware variant: the deterministic pass works on PER-FIELD hits
 * (subject, body, each filename) — joining first would let \s+ in the
 * patterns match across field boundaries and flag phrases that exist in no
 * field. MNPI is additionally checked ACROSS fields (crossFieldMnpiHold);
 * only the promissory patterns are seam-fenced. The LLM still reads the
 * joined text (it judges intent, not regex seams).
 *
 * Verdict routing (decision 2, option A — triage #164, Aug 13):
 *   - a promissory hit WITHOUT the sender's sign-off  -> blocked
 *   - promissory hits ALL signed off, no MNPI         -> pass to the LLM
 *     (the override is the sender's call; the caller audits it)
 *   - any MNPI signal, signed off or not              -> hold, cause 'mnpi'
 *     (firm-level exposure is never the sender's call)
 *   - LLM may still escalate for net-new concerns; a reputational-only LLM
 *     hold carries cause 'reputational' (the sender-facing soft hold).
 *   - the one exception to "never downgraded" (D82, off by default): on the
 *     send path, Jev may clear a rule flag left after sign-offs; see
 *     secondOpinion.ts. The Claude pass still runs after a clear.
 */
export async function fullScreenFields(
  fields: string[],
  model: ModelCallDecision,
  opts?: FullScreenOptions,
): Promise<ScreenedVerdict> {
  // Refused before anything runs: a decision this module cannot trace to
  // modelCallsAllowed is a forged one, whatever it says, and one minted for
  // another purpose (a codename suggestion) cannot open a screen.
  const decision = assertModelDecision(model, SCREEN_PURPOSES);
  const gate = modelAuditFields(decision);

  const hitsByKey = new Map<string, ScreenHit>();
  for (const field of fields) {
    for (const hit of findScreenHits(field)) {
      if (!hitsByKey.has(hit.key)) hitsByKey.set(hit.key, hit);
    }
  }

  const claims = (opts?.claims ?? [])
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0 && t.length <= 120);
  const preApproved = [...new Set(claims)].filter((key) => hitsByKey.has(key)).slice(0, 50);
  const approved = new Set(preApproved);

  const hits = [...hitsByKey.values()];
  const unackedPromissory = hits.find((h) => h.kind === 'promissory' && !approved.has(h.key));
  const mnpi = hits.some((h) => h.kind === 'mnpi') || crossFieldMnpiHold(fields) !== null;

  let deterministic: ComplianceCheckResult;
  let holdCause: HoldCause | undefined;
  if (unackedPromissory) {
    deterministic = {
      verdict: 'blocked',
      reasons: [PROMISSORY_FLAG],
      rewrite: unackedPromissory.note,
    };
  } else if (mnpi) {
    deterministic = { verdict: 'hold', reasons: [MNPI_FLAG] };
    holdCause = 'mnpi';
  } else {
    deterministic = { verdict: 'compliant', reasons: [] };
  }

  // Jev's second opinion (D82, off by default): the one step that may LOWER
  // a rule verdict, so it fails closed. A clear makes the rules' read
  // compliant and lets the escalate-only Claude pass below run (a rules
  // block would otherwise skip it); a cleared send floors at Sampled
  // (riskBandFor). `mnpi` keeps its value: a Claude escalation after a clear
  // still names the MNPI exposure the rules saw.
  const second =
    deterministic.verdict !== 'compliant' && opts?.secondOpinion
      ? await secondOpinionOn(
          opts.secondOpinion,
          {
            promissory: hits.filter((h) => h.kind === 'promissory' && !approved.has(h.key)),
            mnpi: hits.filter((h) => h.kind === 'mnpi'),
            crossFieldMnpi: crossFieldMnpiHold(fields) !== null,
          },
          fields,
        )
      : null;
  // The rules' own read, kept so a clear the Claude pass cannot confirm is undone.
  const rulesVerdict = deterministic;
  if (second?.record.outcome === 'cleared') {
    deterministic = { verdict: 'compliant', reasons: [] };
    holdCause = undefined;
  }
  const secondOpinionFields = second
    ? { secondOpinion: second.record, ...(second.ai ? { secondOpinionAi: second.ai } : {}) }
    : {};
  // The LLM judges one joined text. The caller's audit evidence / send-as-is
  // binding (outbox route) deliberately does NOT hash this join: it hashes
  // the fields as a JSON array, because the deterministic pass above screens
  // fields separately and two decompositions of the same bytes can read
  // differently (#192 slice 2b review).
  const text = fields.join('\n\n');

  // Lexicon signals are matched PER FIELD, like the deterministic hits above:
  // joining first would let \s+ match across field seams and mint phrases
  // that exist in no field — phantom audit evidence. Context for the LLM and
  // evidence for the audit, never a rules-layer verdict input (#163 — "this
  // is not a blocking list").
  const lexiconByPhrase = new Map<string, LexiconHit>();
  for (const field of fields) {
    for (const hit of findLexiconHits(field)) {
      if (!lexiconByPhrase.has(hit.phrase)) lexiconByPhrase.set(hit.phrase, hit);
    }
  }
  // Audit evidence is capped PER TIER (never overall): Tier 3's only
  // surface is this record, and a global cap sorted by severity would trim
  // exactly the Tier-3 tail first. The prompt applies its own transport cap
  // after the doctrine filter (systemPrompt).
  const perTier = new Map<number, number>();
  const lexiconSignals = [...lexiconByPhrase.values()]
    .sort((a, b) => a.tier - b.tier || a.phrase.localeCompare(b.phrase))
    .filter((hit) => {
      const n = perTier.get(hit.tier) ?? 0;
      perTier.set(hit.tier, n + 1);
      return n < LEXICON_AUDIT_CAP_PER_TIER;
    });
  const lexicon = { version: LEXICON_VERSION, signals: lexiconSignals };

  if (deterministic.verdict === 'blocked') {
    // A message can carry BOTH an unacked promissory hit and an MNPI signal:
    // the block wins the verdict, but the MNPI exposure must not vanish from
    // the record — the cause names the stronger concern (#192 review).
    return {
      ...deterministic,
      llmChecked: false,
      preApproved,
      lexicon,
      ...(mnpi ? { holdCause: 'mnpi' as const } : {}),
      ...gate,
      ...secondOpinionFields,
    };
  }

  const { verdict: llm, ai } = await runLlmScreen(text, decision, { preApproved, lexiconSignals });
  if (second?.record.outcome === 'cleared' && !llm) {
    // Fail closed (D87): a Jev clear stands only when the escalate-only Claude
    // pass actually ran over the cleared email. No key, a timeout, an
    // unreadable reply or a withheld model gate restores the rules' verdict,
    // and the record says error.
    return {
      ...rulesVerdict,
      llmChecked: false,
      preApproved,
      lexicon,
      ...(mnpi ? { holdCause: 'mnpi' as const } : {}),
      ...(ai ? { ai } : {}),
      ...gate,
      secondOpinion: { ...second.record, outcome: 'error', clearedReasons: [] },
      ...(second.ai ? { secondOpinionAi: second.ai } : {}),
    };
  }
  const merged = mergeVerdicts(deterministic, llm);
  // The model's own cause label is cross-checked: a 'reputational' label whose
  // REASONS read like an information leak is treated as MNPI — fail-closed
  // covers a missing label, this covers a wrong one. The queue's no-bypass
  // boundary must not rest on model self-reporting alone.
  const MNPI_HINT_RX =
    /\b(mnpi|material non[- ]public|non[- ]public|valuation|price|floor|write[- ]down|unannounced|internal (model|valuation)|board minutes|leak)\b/i;
  const llmCause =
    llm?.holdCause === 'reputational' && MNPI_HINT_RX.test(llm.reasons.join(' '))
      ? 'mnpi'
      : llm?.holdCause;
  // A cause survives ESCALATION too: a deterministic MNPI hold the LLM
  // escalates to blocked is still an MNPI exposure — dropping the cause
  // would relabel it 'promissory' downstream (#192 review).
  const cause =
    merged.verdict === 'hold'
      ? (holdCause ?? llmCause ?? 'mnpi')
      : merged.verdict === 'blocked' && mnpi
        ? ('mnpi' as const)
        : undefined;
  return {
    ...merged,
    ...(cause ? { holdCause: cause } : {}),
    ...(llm?.rewrite != null ? { rewriteIsBody: true } : {}),
    preApproved,
    lexicon,
    // Heat rides on EVERY verdict: the soft-hold modal reads it on holds and
    // riskBandFor consumes it on compliant sends (#192) — then it is dropped.
    // Stripping it for compliant verdicts made the heat band tiers dead code.
    ...(typeof llm?.heat === 'number' ? { heat: llm.heat } : {}),
    ...(ai ? { ai } : {}),
    ...gate,
    ...secondOpinionFields,
  };
}

/**
 * One LLM pass over the message text, with its bill. The verdict is null on
 * ANY failure (no key, network, non-JSON, invalid shape): the caller falls
 * back to the deterministic verdict, never to an error. The usage is reported
 * whenever the API answered, even when the reply could not be read as a
 * verdict (a paid call that lands nowhere on the ledger is the drift the
 * ledger exists to catch). Module-private (#339), and it asserts the minted
 * decision itself, right before the gateway call: a withheld decision sends
 * nothing and reads as no pass.
 */
async function runLlmScreen(
  text: string,
  model: ModelCallDecision,
  opts?: ScreenOptions,
): Promise<{ verdict: LlmVerdict | null; ai: AiCallUsage | null }> {
  if (!assertModelDecision(model, SCREEN_PURPOSES).allowed) return { verdict: null, ai: null };
  const r = await postGatewayMessages({
    feature: 'compliance_screen',
    model: screenGatewayModel(),
    system: systemPrompt(opts),
    user: text,
    maxTokens: MAX_TOKENS,
    timeoutMs: TIMEOUT_MS,
  });
  // Billed regardless of whether the reply reads or parses below.
  const ai = ledgerUsage(r.usage ?? null);
  if (!r.ok) {
    // The gateway client logged the outcome (model_outcome, #474): no key, a ZDR refusal and a timeout need nothing more.
    if (r.code === 'http') {
      // The status only: the body can quote the message, and its code-shaped error type can be a deal code (#474).
      console.error('[complianceLlm] AI Gateway request failed', r.status ?? 'none');
    }
    return { verdict: null, ai };
  }

  try {
    const reply = r.text;
    if (!reply) return { verdict: null, ai };

    const parsed = JSON.parse(reply) as {
      verdict?: unknown;
      reasons?: unknown;
      rewrite?: unknown;
      cause?: unknown;
      heat?: unknown;
    };
    if (typeof parsed.verdict !== 'string' || !VERDICTS.has(parsed.verdict)) {
      return { verdict: null, ai };
    }
    const reasons = Array.isArray(parsed.reasons)
      ? parsed.reasons.filter((r): r is string => typeof r === 'string')
      : [];

    const result: LlmVerdict = {
      verdict: parsed.verdict as ComplianceCheckResult['verdict'],
      reasons,
    };
    if (typeof parsed.rewrite === 'string' && parsed.rewrite) result.rewrite = parsed.rewrite;
    // Lenient extras (#158): a bad cause is dropped (the caller fails closed
    // to the queue); heat is clamped to an integer 0-100.
    if (parsed.cause === 'mnpi' || parsed.cause === 'reputational') {
      result.holdCause = parsed.cause;
    }
    if (typeof parsed.heat === 'number' && Number.isFinite(parsed.heat)) {
      result.heat = Math.max(0, Math.min(100, Math.round(parsed.heat)));
    }
    if (ai) result.ai = ai;
    return { verdict: result, ai };
  } catch {
    return { verdict: null, ai };
  }
}
