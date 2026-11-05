import { describe, expect, it } from 'vitest';

import { allCopyStrings, type CopyString } from './helpers/visibleCopy';

/**
 * Rules for words a reader can see, held mechanically over every
 * string literal and JSX text in src (comments are never read):
 *
 *   1. No em dash (U+2014) or its HTML entity in a string. The few kept are
 *      listed in DASH_EXEMPT by exact string, each with a reason: model
 *      prompts, one parsing pattern, a stored Box folder separator, and stored
 *      select values that saved records already hold. No ARIA or regulatory
 *      separator is kept.
 *   2. No banned jargon: orchestration, spine, station, array, seam,
 *      perimeter, tenant, mount, binding, publication, "reader registration",
 *      issue numbers like "(#192)", and "register" used as a noun ("the
 *      register"). Prose is checked for all of them; a single-word string is
 *      checked as a label ("Tenant") so ids and column names do not trip it.
 *      The plain verb ("register a lead") is allowed.
 *
 * Code a reader never sees (the agent API, the inbound webhook, mail readers,
 * workers, SQL that mirrors migrations) is listed by specific file in
 * JARGON_EXEMPT, each with a reason. Everything else under src is scanned, so a
 * new string in a directory that reaches the UI cannot slip through. Catalog
 * text keeps the finance senses of "publication", "binding" and "register".
 */

type Exempt = { file: RegExp; why: string; text?: (t: string) => boolean };

/**
 * Em dashes kept on purpose, each by exact string (or a distinctive prefix of
 * a long prompt), never by whole file. No ARIA or regulatory separator is kept.
 */
const DASH_EXEMPT: Exempt[] = [
  { file: /lib\/compliance\/llm\.ts$/, why: 'model prompt, never shown', text: (t) => /^(For hold and blocked verdicts include|A tier is a ceiling|Do not escalate for those terms|Still escalate for genuinely DISTINCT)/.test(t) },
  { file: /lib\/gate0\/codenameLlm\.ts$/, why: 'model prompt, never shown', text: (t) => /^(The code name must NEVER reveal|Themes should feel inspired|Industry context only)/.test(t) },
  { file: /lib\/ignatious\/applyPresearch\.ts$/, why: 'parsing pattern that must recognize a dash in model output', text: (t) => t.includes('[—,:–-]') },
  { file: /lib\/dataroom\/steps\.ts$/, why: 'separator in a stored Box folder name; changing it orphans folders already filed', text: (t) => t === ' — ' },
  { file: /lib\/ignatious\/stepSkillIo\.ts$/, why: 'separator inside the model prompt that lists lead-map rows', text: (t) => t === ' — ' },
  { file: /lib\/rail\/manualStepDefs\.ts$/, why: 'stored select values: saved records hold these exact strings; the screen shows the label of each option instead', text: (t) => ['Fail — fixes required', 'Terminated — expiration', 'Terminated — voluntary'].includes(t) },
];

/**
 * Jargon kept on purpose in code a reader never sees, by specific file (never a
 * directory) or exact string. Anything new under src is scanned.
 */
const JARGON_EXEMPT: Exempt[] = [
  { file: /app\/api\/v1\/inbound\/webhook\/route\.ts$/, why: 'machine webhook: the parameter is literally named tenant' },
  { file: /app\/v1\/leads\/\[leadId\]\/change-tracking\/route\.ts$/, why: 'agent API error, not shown in the app' },
  { file: /lib\/conductia\/(auth|lead|route)\.ts$/, why: 'agent API errors and header names, not shown in the app' },
  { file: /lib\/audit\/chain\.ts$/, why: 'integrity-check error thrown to operators' },
  { file: /lib\/constants\/discovery\.ts$/, why: 'SQL predicates and table descriptions that mirror migrations, which cannot change' },
  { file: /lib\/discovery\/(exclusion\/errors|indexDigest)\.ts$/, why: 'worker error text' },
  { file: /lib\/google\/reader\/(mail|registration)\.ts$/, why: 'mail reader worker error text' },
  { file: /lib\/graph\/reader\/(certificateSource|groupMirror|token)\.ts$/, why: 'mail reader worker error text' },
  { file: /lib\/mailboxAccess\/readers\.ts$/, why: 'mail reader guard error text' },
  { file: /lib\/skillPublication\/(parse|parseService)\.ts$/, why: 'service-to-service validation text pinned by the skill publication contract tests' },
  { file: /lib\/skillPublication\/(audit|processor|processorAuth|processorRead|processorTransition)\.ts$/, why: 'worker and audit labels, not shown in the app' },
  { file: /lib\/skillRun\/publicationMetadata\.ts$/, why: 'database read label in a server error' },
  { file: /lib\/ignatious\/stepSkillIo\.ts$/, why: 'model prompt wording ("action register") kept as the model saw it', text: (t) => t.startsWith('Return a flags / sensitivities section') },
];

/** Catalog and mock data: finance wording stays ("publication", "binding", "risk register"). */
const CATALOG = [/lib\/rail\/(dealRail|manualStepDefs|railData\.generated)\.ts$/, /lib\/mock\//];

const DASH = /—|&(?:mdash|#8212|#x2014);/i;
const JARGON =
  /\b(orchestration|spine|stations?|arrays?|seams?|perimeters?|tenants?|mount(?:s|ed|ing)?)\b|\breader registration\b|\(#\d+\)/i;
const LABEL = /^(Orchestration|Spine|Stations?|Arrays?|Seams?|Perimeters?|Tenants?|Mount|Binding|Publications?|Register)$/;
const BINDING_OR_PUBLICATION = /\b(?<!non-)binding\b(?!\s+(?:LOIs?|offers?|IOIs?))|\bpublications?\b/i;
const REGISTER_NOUN = /\b(?:the|an?|action|risk|issue|decision)\s+registers?\b/i;

const normal = (s: CopyString) => s.file.replace(/\\/g, '/');
const covers = (e: Exempt, s: CopyString) => e.file.test(normal(s)) && (!e.text || e.text(s.text));
const exempt = (list: Exempt[], s: CopyString) => list.some((e) => covers(e, s));

/** Rule 1 for one string, before any exemption. */
const dashHit = (s: CopyString) => DASH.test(s.text);

/**
 * Rule 2 for one string, before any exemption: a single-word label, or prose
 * (whitespace and at least 9 characters) with banned jargon, or, outside the
 * catalog, "binding", "publication" or "register" as a noun. The hit test and
 * the staleness test both use this, so an exemption is live only when the
 * guard would really have flagged something it covers.
 */
function jargonHit(s: CopyString): boolean {
  const text = s.text.trim();
  if (LABEL.test(text)) return true;
  if (!/\s/.test(text) || text.length < 9) return false;
  if (JARGON.test(text)) return true;
  const catalog = CATALOG.some((r) => r.test(normal(s)));
  return !catalog && (BINDING_OR_PUBLICATION.test(text) || REGISTER_NOUN.test(text));
}

/**
 * One exemption per member of a file alternation (`lib/conductia/(auth|lead|route)`),
 * so a dead member cannot stay hidden behind a live sibling.
 */
function members(e: Exempt): Exempt[] {
  const group = /(?<!\\)\(([^()]*\|[^()]*)\)/.exec(e.file.source);
  if (!group) return [e];
  const before = e.file.source.slice(0, group.index);
  const after = e.file.source.slice(group.index + group[0].length);
  return group[1].split('|').map((alt) => ({ ...e, file: new RegExp(before + alt + after, e.file.flags) }));
}

const all = allCopyStrings(['src']);
const show = (list: CopyString[]) => list.map((s) => `${s.file}:${s.line} ${JSON.stringify(s.text.trim().slice(0, 90))}`);

describe('visible copy rules', () => {
  it('reads strings out of source (the scan is not empty)', () => {
    expect(all.length).toBeGreaterThan(5000);
  });

  it('has no em dash, or its HTML entity, in any string', () => {
    const hits = all.filter((s) => dashHit(s) && !exempt(DASH_EXEMPT, s));
    expect(show(hits)).toEqual([]);
  });

  it('has no banned jargon in prose or labels a reader can see', () => {
    const hits = all.filter((s) => jargonHit(s) && !exempt(JARGON_EXEMPT, s));
    expect(show(hits)).toEqual([]);
  });

  it('every exemption, and every member of a file alternation, still covers a string the guard would flag (a stale one is deleted)', () => {
    const checks = [
      ...DASH_EXEMPT.flatMap(members).map((e) => ({ e, hit: dashHit })),
      ...JARGON_EXEMPT.flatMap(members).map((e) => ({ e, hit: jargonHit })),
    ];
    const stale = checks.filter(({ e, hit }) => !all.some((s) => covers(e, s) && hit(s)));
    expect(stale.map(({ e }) => `${e.file} ${e.why}`)).toEqual([]);
  });
});
