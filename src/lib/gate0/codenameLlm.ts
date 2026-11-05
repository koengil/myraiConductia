import { assertModelDecision, type ModelCallDecision, type ModelPurpose } from '@/lib/ai/modelPolicy';
import { ledgerUsage, type AiCallUsage } from '@/lib/ai/usage';
import {
  codenameMasksCompany,
  slugify,
  type SearchableCompany,
} from '@/lib/rail/deals';

import { extractJsonPayload } from '@/lib/modelGateway/json';
import { gatewayModelId, postGatewayMessages } from '@/lib/modelGateway/gatewayClient';

import { fallbackCodenameThemes } from './codenameFallback';
import {
  CODENAME_SUGGESTIONS_PER_THEME,
  type CodenameSuggestResult,
  type CodenameThemeProposal,
} from './codenameTypes';

const DEFAULT_MODEL = 'claude-sonnet-5';
const TIMEOUT_MS = 12_000;
const MAX_TOKENS = 2048;

const SYSTEM_PROMPT = [
  'You propose confidential M&A deal code names for investment bankers.',
  'The code name must NEVER reveal the target company — no company name, ticker, product names, founder names, or recognizable references.',
  'Each code name is formatted exactly as "Project {Word}" where {Word} is one evocative word on the theme.',
  'Themes should feel inspired by the target sector and business vibe, but stay abstract (metaphors, imagery, industry nouns — not brand names).',
  'Return ONLY valid JSON, no markdown:',
  '{ "themes": [ { "label": "Theme name", "suggestions": ["Project Alpha", "Project Beta", "Project Gamma", "Project Delta", "Project Echo"] } ] }',
  `Exactly 3 themes. Exactly ${CODENAME_SUGGESTIONS_PER_THEME} suggestions per theme. Every suggestion must start with "Project ".`,
].join(' ');

function normalizeProjectName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const word = trimmed.replace(/^project\s+/i, '').trim();
  if (!word) return '';
  return `Project ${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

/** Drop suggestions that leak the target name; require five valid picks per theme. */
export function sanitizeCodenameThemes(
  raw: CodenameThemeProposal[],
  company: SearchableCompany,
  count = CODENAME_SUGGESTIONS_PER_THEME,
): CodenameThemeProposal[] {
  const out: CodenameThemeProposal[] = [];
  for (const theme of raw) {
    const label = theme.label?.trim();
    if (!label) continue;
    const seen = new Set<string>();
    const suggestions: string[] = [];
    for (const item of theme.suggestions ?? []) {
      const name = normalizeProjectName(typeof item === 'string' ? item : '');
      if (!name || seen.has(name.toLowerCase())) continue;
      if (!codenameMasksCompany(name, company)) continue;
      seen.add(name.toLowerCase());
      suggestions.push(name);
      if (suggestions.length >= count) break;
    }
    if (suggestions.length < count) continue;
    out.push({
      id: slugify(label),
      label,
      suggestions,
    });
  }
  return out;
}

function buildUserPrompt(company: SearchableCompany, offset: number): string {
  return [
    `Target sector: ${company.sector.trim() || 'Private company'}.`,
    `Industry context only — do NOT use this company name in output: "${company.name}".`,
    offset > 0 ? `Variation seed: ${offset} (produce a fresh set).` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const CODENAME_PURPOSES: readonly ModelPurpose[] = ['codename_suggest'];

/** Reports the model usage of one codename call, for the AI spend ledger. */
export type CodenameUsageSink = (ai: AiCallUsage) => void;

/** The raw call. Module-private (#339), and it asserts the minted decision itself, right before the gateway call. */
async function llmSuggestCodenames(
  company: SearchableCompany,
  offset: number,
  model: ModelCallDecision,
  onUsage?: CodenameUsageSink,
): Promise<CodenameThemeProposal[] | null> {
  if (!assertModelDecision(model, CODENAME_PURPOSES).allowed) return null;
  const r = await postGatewayMessages({
    feature: 'codename_suggest',
    model: gatewayModelId(
      process.env.CODENAME_LLM_MODEL || process.env.SCREEN_LLM_MODEL || DEFAULT_MODEL,
    ),
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(company, offset),
    maxTokens: MAX_TOKENS,
    timeoutMs: TIMEOUT_MS,
    // Sonnet 5 adaptive thinking is on by default and counts against
    // max_tokens; this is a small JSON task, so thinking just burns the
    // budget or the 12s timeout and we silently fall back.
    thinking: { type: 'disabled' },
  });
  // The gateway client logged the outcome (model_outcome, #474); an http failure also logs its status here.
  if (!r.ok && r.code === 'http') {
    // The status only: the body can quote the prompt, and its code-shaped error type can be a deal code (#474).
    console.error('[codenameLlm] AI Gateway request failed', r.status ?? 'none');
  }

  try {
    // Billed regardless of whether the reply reads or parses below.
    const ai = ledgerUsage(r.usage ?? null);
    if (ai) onUsage?.(ai);
    if (!r.ok) return null;
    const reply = r.text;
    if (!reply) return null;

    const parsed = JSON.parse(extractJsonPayload(reply)) as {
      themes?: Array<{ label?: unknown; suggestions?: unknown }>;
    };
    if (!Array.isArray(parsed.themes)) return null;

    const raw: CodenameThemeProposal[] = parsed.themes.map((t, i) => ({
      id: slugify(typeof t.label === 'string' ? t.label : `theme-${i + 1}`),
      label: typeof t.label === 'string' ? t.label : `Theme ${i + 1}`,
      suggestions: Array.isArray(t.suggestions)
        ? t.suggestions.filter((s): s is string => typeof s === 'string')
        : [],
    }));

    return sanitizeCodenameThemes(raw, company);
  } catch {
    return null;
  }
}

/**
 * Propose three themed code-name sets for Gate 0. Uses the AI Gateway when configured
 * and the model gate allows the call (#339: the prompt names the target, which is
 * tenant content); falls back to the deterministic Birds / Football / Movies sets
 * when withheld and on any failure.
 */
export async function suggestCodenames(
  company: SearchableCompany,
  offset: number,
  model: ModelCallDecision,
  onUsage?: CodenameUsageSink,
): Promise<CodenameSuggestResult> {
  // Refused before anything runs, whatever the decision says, when it was not minted for a code-name call.
  const decision = assertModelDecision(model, CODENAME_PURPOSES);
  const llmThemes = await llmSuggestCodenames(company, offset, decision, onUsage);
  if (llmThemes && llmThemes.length >= 3) {
    return { themes: llmThemes.slice(0, 3), source: 'llm' };
  }
  return fallbackCodenameThemes(company, offset);
}
