import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findLexiconHits,
  LEXICON_AUDIT_CAP_PER_TIER,
  LEXICON_CATEGORY_SHORT,
  LEXICON_SIGNAL_CAP,
  LEXICON_TIER_SURFACE,
  LEXICON_VERSION,
  lexiconCategoryName,
} from '../src/lib/compliance/lexicon';
import { LEXICON_CATEGORIES, LEXICON_ENTRIES } from '../src/lib/compliance/lexicon.generated';
import { fullScreenFields, systemPrompt } from '../src/lib/compliance/llm';
import { allowedDecision } from './helpers/modelDecision';

// The model gate (#339) open on the DEV tenant's synthetic path: these tests
// are about the lexicon, so the model pass may run whenever a key is set.
const allowed = allowedDecision('mail_screen');

/*
 * The Communications Risk Lexicon as SIGNALS (#163).
 *
 * Doctrine under test, from the lexicon's own operating standard: "this is
 * not a blocking list", "a tier is a ceiling, not an assessment". Lexicon
 * hits are context for the AI layer and evidence for the audit — they NEVER
 * set a deterministic verdict (screen.ts's promissory/MNPI rules remain the
 * only rule-layer verdict-setters).
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('lexicon library (generated)', () => {
  it('carries the full v1.0 index: 521 phrases, 393/114/14 by tier', () => {
    expect(LEXICON_VERSION).toBe('1.0 (2026-08-11)');
    expect(LEXICON_ENTRIES).toHaveLength(521);
    const byTier = (t: number) => LEXICON_ENTRIES.filter((e) => e.tier === t).length;
    expect([byTier(1), byTier(2), byTier(3)]).toEqual([393, 114, 14]);
  });

  it('every phrase sits in one of the 24 categories and one of the 228 families (#163 slice 5)', () => {
    expect(Object.keys(LEXICON_CATEGORIES)).toHaveLength(24);
    expect(LEXICON_CATEGORIES[1]).toMatch(/^Off-Channel Migration/);
    expect(LEXICON_CATEGORIES[24]).toMatch(/^Privilege/);
    const families = new Set<number>();
    for (const e of LEXICON_ENTRIES) {
      expect(e.category, e.phrase).toBeGreaterThanOrEqual(1);
      expect(e.category, e.phrase).toBeLessThanOrEqual(24);
      expect(e.family, e.phrase).toBeGreaterThanOrEqual(1);
      expect(e.family, e.phrase).toBeLessThanOrEqual(228);
      families.add(e.family);
    }
    expect(families.size).toBe(228);
    // A hit carries its category so the strip, the prompt and the audit can
    // gloss it — "make every alert explainable".
    expect(findLexiconHits('ok, text me later')[0].category).toBe(1);
  });

  it('every category has a short label for the composer strip, and a full name', () => {
    for (let c = 1; c <= 24; c++) {
      expect(LEXICON_CATEGORY_SHORT[c], `category ${c}`).toMatch(/^\S.{1,28}$/);
      expect(lexiconCategoryName(c), `category ${c}`).toBe(LEXICON_CATEGORIES[c]);
    }
    expect(LEXICON_CATEGORY_SHORT[1]).toBe('Off-channel');
    expect(LEXICON_CATEGORY_SHORT[2]).toBe('MNPI');
  });
});

describe('tier surfacing doctrine (#163 slice 5)', () => {
  it('Tier 1 reaches the sender; Tier 2 reaches the AI and the audit only; Tier 3 the audit only', () => {
    // From the standard: T1 "urgent"; T2 "review with context… coaching is
    // often the right outcome" (supervision-side, not the sender pre-send);
    // T3 "do not escalate or coach on these alone" (analytics only).
    expect(LEXICON_TIER_SURFACE[1]).toEqual({ sender: true, ai: true, audit: true });
    expect(LEXICON_TIER_SURFACE[2]).toEqual({ sender: false, ai: true, audit: true });
    expect(LEXICON_TIER_SURFACE[3]).toEqual({ sender: false, ai: false, audit: true });
  });

  it('a Tier-3 phrase reaches the audit evidence but NOT the AI prompt', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    // "code name only" is Tier 3 (standard practice on live mandates).
    const t3 = LEXICON_ENTRIES.find((e) => e.phrase === 'code name only');
    expect(t3?.tier).toBe(3);
    const screened = await fullScreenFields(['Please use the code name only in all correspondence.'], allowed);
    expect(screened.lexicon?.signals.some((s) => s.phrase === 'code name only')).toBe(true);
    const prompt = systemPrompt({ lexiconSignals: screened.lexicon?.signals });
    expect(prompt).not.toContain('code name only');
    expect(prompt).not.toContain('Communications Risk Lexicon (version');
  });

  it('the AI prompt names the category with each surfaced phrase', () => {
    const prompt = systemPrompt({
      lexiconSignals: [{ phrase: 'text me', tier: 1, category: 1, family: 1 }],
    });
    expect(prompt).toContain('"text me" (tier 1, Off-Channel Migration, Recordkeeping and Concealment)');
  });
});

describe('findLexiconHits', () => {
  it('matches a phrase case-insensitively with word boundaries', () => {
    const hits = findLexiconHits('Please BACKDATE the engagement letter.');
    expect(hits.some((h) => h.phrase === 'backdate' && h.tier === 1)).toBe(true);
  });

  it('a word inside another word is NOT a hit', () => {
    // 'agreed' is a Tier 2 entry; 'disagreed' must not trip it.
    expect(findLexiconHits('We disagreed on timing.').some((h) => h.phrase === 'agreed')).toBe(
      false,
    );
    expect(findLexiconHits('Agreed.').some((h) => h.phrase === 'agreed')).toBe(true);
  });

  it('entries starting outside \\w (like "#1") still bound correctly', () => {
    expect(findLexiconHits('This deal is our #1 priority.').some((h) => h.phrase === '#1')).toBe(
      true,
    );
    expect(findLexiconHits('See item #10 on the list.').some((h) => h.phrase === '#1')).toBe(
      false,
    );
  });

  it('a bracketed placeholder matches on its literal prefix', () => {
    // "agree a comp band with [competitor]" — the variable part is anyone.
    const hits = findLexiconHits('We should agree a comp band with Northwind before Q4.');
    expect(hits.some((h) => h.phrase.startsWith('agree a comp band with'))).toBe(true);
  });

  it('smart quotes in the INPUT do not defeat apostrophe entries (Outlook/iOS default)', () => {
    // U+2019 apostrophe — 76 lexicon entries carry a straight apostrophe.
    const hits = findLexiconHits('Please don’t name the client in the deck.');
    expect(hits.some((h) => h.phrase === "don't name the client")).toBe(true);
  });

  it('a trailing ellipsis is an open template, not a literal character', () => {
    const hits = findLexiconHits('We should buy ahead of the announcement.');
    expect(hits.some((h) => h.phrase.startsWith('buy ahead of'))).toBe(true);
  });

  it('slash groups are alternations, never a literal slash requirement', () => {
    // "agree the price/fee/spread" fires on any one of the three words.
    const hits = findLexiconHits("Let's agree the price with them before Friday.");
    expect(hits.some((h) => h.phrase === 'agree the price/fee/spread')).toBe(true);
  });

  it('orders by severity (tier 1 first) and returns [] on clean text', () => {
    const hits = findLexiconHits('Please backdate this. Agreed.');
    expect(hits[0].tier).toBe(1);
    expect(findLexiconHits('The data room opens Monday.')).toEqual([]);
  });
});

describe('lexicon signals in the screen (#163)', () => {
  function stubAnthropic(contentText: string) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ content: [{ type: 'text', text: contentText }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('a lexicon hit NEVER sets the deterministic verdict (not a blocking list)', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    // 'backdate' is Tier 1 in the lexicon but matches no promissory/MNPI rule.
    const result = await fullScreenFields(['Please backdate the engagement letter.'], allowed);
    expect(result.verdict).toBe('compliant');
    expect(result.llmChecked).toBe(false);
    expect(result.lexicon?.version).toBe(LEXICON_VERSION);
    expect(result.lexicon?.signals.some((s) => s.phrase === 'backdate')).toBe(true);
  });

  it('signals reach the AI prompt with the ceiling rule attached', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'test-key');
    const fetchMock = stubAnthropic(JSON.stringify({ verdict: 'compliant', reasons: [] }));
    await fullScreenFields(['Please backdate the engagement letter.'], allowed);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { system: string };
    expect(body.system).toContain('Communications Risk Lexicon');
    expect(body.system).toContain(`version ${LEXICON_VERSION}`);
    expect(body.system).toContain('"backdate" (tier 1, Books, Records, Accounting, Valuation and Control Override)');
    expect(body.system).toContain('A tier is a ceiling, not an assessment');
    expect(body.system).toContain('never escalate on a phrase match alone');
    // Without signals the base prompt is untouched.
    expect(systemPrompt()).not.toContain('Communications Risk Lexicon');
  });

  it('signals are capped for transport', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    // A text stuffed with distinct lexicon phrases still caps the payload.
    const stuffed = LEXICON_ENTRIES.filter((e) => !e.phrase.includes('['))
      .slice(0, 40)
      .map((e) => e.phrase)
      .join('. ');
    const result = await fullScreenFields([stuffed], allowed);
    expect(result.lexicon?.signals.length).toBeLessThanOrEqual(LEXICON_AUDIT_CAP_PER_TIER * 3);
    const prompt = systemPrompt({ lexiconSignals: result.lexicon?.signals });
    expect((prompt.match(/\(tier \d, /g) ?? []).length).toBeLessThanOrEqual(LEXICON_SIGNAL_CAP);
  });

  it('a Tier-1 flood never pushes a Tier-3 hit out of the audit (its only surface)', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const t1 = LEXICON_ENTRIES.filter((e) => e.tier === 1 && !e.phrase.includes('['))
      .slice(0, LEXICON_SIGNAL_CAP + 4)
      .map((e) => e.phrase);
    const result = await fullScreenFields([[...t1, 'code name only'].join('. ')], allowed);
    const signals = result.lexicon?.signals ?? [];
    expect(signals.filter((s) => s.tier === 1)).toHaveLength(LEXICON_AUDIT_CAP_PER_TIER);
    expect(signals.some((s) => s.phrase === 'code name only' && s.tier === 3)).toBe(true);
    // …while the prompt still gets only the capped Tier-1/2 transport.
    const prompt = systemPrompt({ lexiconSignals: signals });
    expect(prompt).not.toContain('code name only');
  });

  it('signals are per-field: a phrase spanning two fields is NOT a hit (seam fence)', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    // Joined with \n\n these fields would mint "better not to ask" (tier 1) —
    // a phrase that exists in neither field. Phantom evidence is worse than
    // no evidence.
    const result = await fullScreenFields([
      'Quarterly check-in: better',
      'not to ask the team for extra slides this week.',
    ], allowed);
    expect(result.lexicon?.signals.some((s) => s.phrase === 'better not to ask')).toBe(false);
  });

  it('a rules-blocked message still carries the lexicon evidence', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const result = await fullScreenFields(['We guarantee the outcome. Please backdate it.'], allowed);
    expect(result.verdict).toBe('blocked');
    expect(result.lexicon?.signals.some((s) => s.phrase === 'backdate')).toBe(true);
  });
});
