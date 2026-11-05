import type { SupabaseClient } from '@supabase/supabase-js';

import { upsertCrmPerson } from '@/lib/api/v1/crmPeople';
import { DECISION_ROLES, MOTIVATIONS, STANCES } from '@/lib/constants/leadMaps';
import { TABLE } from '@/lib/constants/tables';
import { errorCodeOf } from '@/lib/errors/upstream';

/** First words of presearch memo sections. Never treat these as people. */
const HEADING_STARTERS = new Set([
  'attendee',
  'biggest',
  'bottom',
  'buyer',
  'call',
  'company',
  'conclusion',
  'core',
  'dissent',
  'footer',
  'framing',
  'funding',
  'hard',
  'how',
  'internal',
  'labeling',
  'most',
  'one',
  'optionality',
  'our',
  'plain',
  'posture',
  'read',
  'recency',
  'role',
  'scripted',
  'source',
  'standalone',
  'strategic',
  'success',
  'swot',
  'the',
  'tier',
  'timed',
  'traps',
  'value',
  'verify',
  'what',
  'who',
  'why',
]);

const SECTION_WORDS = new Set([
  ...HEADING_STARTERS,
  'actually',
  'appendix',
  'ask',
  'avoid',
  'before',
  'brief',
  'connections',
  'context',
  'decides',
  'execution',
  'frame',
  'helpful',
  'in',
  'kind',
  'line',
  'map',
  'maximization',
  'meeting',
  'page',
  'partners',
  'plan',
  'profiles',
  'questions',
  'room',
  'they',
  'this',
  'to',
  'us',
  'walk',
  'we',
  'will',
]);

const ORG_SUFFIXES = new Set([
  'capital',
  'company',
  'corp',
  'corporation',
  'fund',
  'group',
  'holdings',
  'inc',
  'incorporated',
  'llc',
  'llp',
  'ltd',
  'management',
  'partners',
  'plc',
  'ventures',
]);

const NAME_TOKEN = String.raw`[A-Z][A-Za-z'.-]+`;
const PERSON_NAME = String.raw`${NAME_TOKEN}(?:\s+${NAME_TOKEN}){1,2}`;

export type ExtractedPerson = { name: string; title: string | null };

export function extractPeopleFromMemo(memo: string): ExtractedPerson[] {
  const found = new Map<string, ExtractedPerson>();

  const add = (rawName: string | undefined, rawTitle: string | undefined) => {
    const name = rawName?.trim();
    if (!name || !isPersonName(name)) return;
    const key = name.toLowerCase();
    if (found.has(key) || found.size >= 12) return;
    found.set(key, { name, title: cleanTitle(rawTitle) });
  };

  // Profile heading: ### Dylan Field, Co-Founder, Chair, CEO
  for (const match of memo.matchAll(new RegExp(`^#{2,3}\\s+(${PERSON_NAME})\\s*,\\s*(.+)$`, 'gm'))) {
    add(match[1], match[2]);
  }

  // Two people in one bold: **Danny Rimer (Index Ventures) and Andrew Reed (Sequoia)**
  for (const match of memo.matchAll(
    new RegExp(`\\*\\*(${PERSON_NAME})\\s*\\(([^)]+)\\)\\s+and\\s+(${PERSON_NAME})\\s*\\(([^)]+)\\)\\*\\*`, 'g'),
  )) {
    add(match[1], match[2]);
    add(match[3], match[4]);
  }

  // **John Lilly (Lead Independent Director, Greylock)**
  for (const match of memo.matchAll(new RegExp(`\\*\\*(${PERSON_NAME})\\s*\\(([^)]+)\\)`, 'g'))) {
    add(match[1], match[2]);
  }

  // **Nathan Ellery** — CEO  /  **Elliot Sandoval**, Partner
  for (const match of memo.matchAll(
    new RegExp(
      `\\*\\*(${PERSON_NAME})\\*\\*(?:\\s*[—,:–-]\\s*|\\s+is\\s+(?:the\\s+)?)([^\\n.*]{2,80})`,
      'g',
    ),
  )) {
    add(match[1], match[2]);
  }

  // **Real decision-maker: Dylan Field**
  for (const match of memo.matchAll(new RegExp(`\\*\\*[^\\n*]{0,40}:\\s*(${PERSON_NAME})\\*\\*`, 'g'))) {
    add(match[1], undefined);
  }

  return [...found.values()];
}

export async function applyPresearchToLead(opts: {
  admin: SupabaseClient;
  companyId: string;
  tenantId: string;
  registeredByCompanyId: string | null;
  actorId: string;
  executionId: string;
  memo: string | (() => Promise<string>);
}): Promise<{ peopleAdded: number; peopleSkipped?: number; alreadyApplied: boolean }> {
  const claim = await claimExecution(opts);
  if (claim === null) return { peopleAdded: 0, alreadyApplied: true };
  try {
    const memo = typeof opts.memo === 'string' ? opts.memo : await opts.memo();
    if (!memo.trim()) throw new Error('presearch memo is empty');
    return await applyClaimed({ ...opts, memo }, claim);
  } catch (error) {
    // Another apply owns the claim now; it is not ours to release.
    if (error instanceof PresearchApplyPending) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const attempts = await releaseClaim(opts, claim, message);
    if (attempts >= MAX_APPLY_ATTEMPTS) throw new PresearchApplyExhausted(attempts);
    throw error;
  }
}

/** The apply is held by another worker: retry on a later poll. */
export class PresearchApplyPending extends Error {}

/** A prior failure is waiting for its persisted retry deadline. */
export class PresearchApplyRetryScheduled extends Error {}

/** The apply failed MAX_APPLY_ATTEMPTS times: no poll retries it again. */
export class PresearchApplyExhausted extends Error {
  constructor(attempts: number) {
    super(`presearch apply gave up after ${attempts} attempts`);
  }
}

/** Failed applies of one execution before it stops being retried. */
export const MAX_APPLY_ATTEMPTS = 5;

/** Released ownership; retry_at separately controls when a takeover is eligible. */
const RELEASED_AT = new Date(0).toISOString();

/**
 * Release ownership and back off for 30, 60, 120, then 240 seconds. Persist
 * the deadline so reloads and concurrent pollers cannot consume the budget.
 * Compare-and-set on the token leaves another owner alone. Returns the
 * attempts now recorded.
 */
async function releaseClaim(
  opts: Parameters<typeof applyPresearchToLead>[0],
  claim: Claim,
  message: string,
): Promise<number> {
  const attempts = claim.attempts + 1;
  const { data, error } = await opts.admin
    .from(TABLE.LEAD_RESEARCH)
    .update({
      claimed_at: RELEASED_AT,
      attempts,
      last_error: message.slice(0, 1000),
      retry_at: attempts < MAX_APPLY_ATTEMPTS
        ? new Date(Date.now() + 30_000 * 2 ** (attempts - 1)).toISOString() : null,
    })
    .eq('id', claim.id)
    .eq('company_id', opts.companyId)
    .eq('claimed_at', claim.claimedAt)
    .is('completed_at', null)
    .select('id');
  if (error || !data?.length) {
    console.error('[presearch] claim not released', {
      executionId: opts.executionId,
      code: error ? errorCodeOf(error) : 'claim_taken_over',
    });
    return claim.attempts;
  }
  return attempts;
}

async function applyClaimed(
  opts: Omit<Parameters<typeof applyPresearchToLead>[0], 'memo'> & { memo: string },
  claim: Claim,
): Promise<{ peopleAdded: number; peopleSkipped?: number; alreadyApplied: boolean }> {
  const { data: current, error: currentError } = await opts.admin
    .from('lead_stakeholders')
    .select('name')
    .eq('company_id', opts.companyId);
  // The known-names set is what keeps a taken-over apply from re-adding people.
  if (currentError) throw new Error(`presearch stakeholders unreadable (${errorCodeOf(currentError)})`);
  const known = new Set(
    (current ?? []).map((row) => String(row.name ?? '').trim().toLowerCase()).filter(Boolean),
  );

  let peopleSkipped = 0;
  for (const person of extractPeopleFromMemo(opts.memo)) {
    const key = person.name.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);

    const personId = await upsertCrmPerson(opts.admin, {
      tenantId: opts.tenantId,
      registeredByCompanyId: opts.registeredByCompanyId,
      name: person.name,
      title: person.title,
      org: null,
    });

    const { error } = await opts.admin.from('lead_stakeholders').insert({
      tenant_id: opts.tenantId,
      company_id: opts.companyId,
      person_id: personId,
      name: person.name,
      title: person.title,
      org: null,
      role_in_decision: DECISION_ROLES[0],
      motivation: MOTIVATIONS[0],
      stance: STANCES[1] ?? STANCES[0],
      board_seat: false,
      investor: false,
      likely_objections: 'Added from presearch',
      source_execution_id: opts.executionId,
    });
    // Another owner of this execution's claim already added them (a taken-over
    // claim whose first owner was only slow): the unique index is the guard.
    if (error?.code === '23505') continue;
    if (error) {
      peopleSkipped += 1;
      console.error('[presearch] stakeholder not added', {
        executionId: opts.executionId,
        code: errorCodeOf(error),
      });
    }
  }

  // Everyone this execution added, whichever owner of its claim added them.
  const { count, error: countError } = await opts.admin
    .from('lead_stakeholders')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', opts.companyId)
    .eq('source_execution_id', opts.executionId);
  if (countError) throw new Error(`presearch people uncounted (${errorCodeOf(countError)})`);
  const peopleAdded = count ?? 0;

  // People are best-effort: a rejected person does not discard a useful memo
  // or the others added successfully. Only the current owner can finish.
  const { data: done, error: doneError } = await opts.admin
    .from(TABLE.LEAD_RESEARCH)
    .update({
      memo_md: opts.memo.slice(0, 80_000),
      people_added: peopleAdded,
      completed_at: new Date().toISOString(),
    })
    .eq('id', claim.id)
    .eq('company_id', opts.companyId)
    .eq('claimed_at', claim.claimedAt)
    .is('completed_at', null)
    .select('id');
  if (doneError) throw new Error(`presearch completion not recorded (${errorCodeOf(doneError)})`);
  if (!done?.length) throw new PresearchApplyPending('presearch claim taken over by another apply');

  return { peopleAdded, ...(peopleSkipped ? { peopleSkipped } : {}), alreadyApplied: false };
}

/**
 * A claim older than this may be taken over. The first owner may still be
 * running; that is safe because stakeholder inserts are idempotent per
 * execution (lead_stakeholders_presearch_once), not because the owner is dead.
 */
const STALE_CLAIM_MS = 2 * 60 * 1000;

/** The claimed row and the claimed_at this apply set: the token that proves ownership. */
type Claim = { id: string; claimedAt: string; attempts: number };

/**
 * Claim the execution before touching stakeholders (#249). execution_id is
 * unique, so of two concurrent applies only one holds the claim. Returns the
 * claim, or null when the execution was already applied; a live claim throws,
 * so the caller retries on its next poll; a stale claim is taken over.
 */
async function claimExecution(opts: Parameters<typeof applyPresearchToLead>[0]): Promise<Claim | null> {
  const { data: fresh, error } = await opts.admin
    .from(TABLE.LEAD_RESEARCH)
    .insert({
      tenant_id: opts.tenantId,
      company_id: opts.companyId,
      agent: 'presearch',
      execution_id: opts.executionId,
      memo_md: typeof opts.memo === 'string' ? opts.memo.slice(0, 80_000) : '',
      people_added: 0,
      created_by: opts.actorId,
    })
    .select('id, claimed_at')
    .single();
  if (fresh) return { id: String(fresh.id), claimedAt: String(fresh.claimed_at), attempts: 0 };
  if (error?.code !== '23505') {
    throw new Error(`presearch claim failed (${error ? errorCodeOf(error) : 'no_row'})`);
  }

  const { data: held, error: readError } = await opts.admin
    .from(TABLE.LEAD_RESEARCH)
    .select('id, claimed_at, completed_at, attempts, retry_at')
    .eq('execution_id', opts.executionId)
    .eq('company_id', opts.companyId)
    .single();
  if (readError || !held) throw new Error(`presearch claim unreadable (${readError ? errorCodeOf(readError) : 'no_row'})`);
  if (held.completed_at) return null;
  const attempts = Number(held.attempts ?? 0);
  if (attempts >= MAX_APPLY_ATTEMPTS) throw new PresearchApplyExhausted(attempts);
  if (held.retry_at && Date.now() < Date.parse(String(held.retry_at))) {
    throw new PresearchApplyRetryScheduled('presearch apply retry scheduled');
  }
  if (Date.now() - Date.parse(String(held.claimed_at)) < STALE_CLAIM_MS) {
    throw new PresearchApplyPending('presearch apply already in progress');
  }

  // Take the stale claim over, unless another apply beat us to it. Match the
  // attempt too: a failed owner can release claimed_at back to the same epoch.
  const { data: taken, error: takeError } = await opts.admin
    .from(TABLE.LEAD_RESEARCH)
    .update({ claimed_at: new Date().toISOString() })
    .eq('id', held.id)
    .eq('company_id', opts.companyId)
    .eq('claimed_at', held.claimed_at)
    .eq('attempts', attempts)
    .is('completed_at', null)
    .select('id, claimed_at');
  if (takeError || !taken?.length) throw new PresearchApplyPending('presearch apply already in progress');
  return { id: String(held.id), claimedAt: String(taken[0].claimed_at), attempts };
}

function wordKey(word: string): string {
  return word.toLowerCase().replace(/[^a-z]/g, '');
}

function isPersonName(name: string): boolean {
  const words = name.split(/\s+/);
  if (words.length < 2 || words.length > 3) return false;
  if (!words.every((word) => new RegExp(`^${NAME_TOKEN}$`).test(word))) return false;

  const keys = words.map(wordKey);
  if (HEADING_STARTERS.has(keys[0])) return false;
  if (ORG_SUFFIXES.has(keys[keys.length - 1])) return false;
  if (keys.filter((key) => SECTION_WORDS.has(key)).length >= 2) return false;
  if (isSectionCompound(words[0])) return false;
  return true;
}

function isSectionCompound(word: string): boolean {
  if (!word.includes('-')) return false;
  return word.split('-').every((part) => SECTION_WORDS.has(wordKey(part)));
}

function cleanTitle(value: string | undefined): string | null {
  if (!value) return null;
  const title = value.replace(/[.*]/g, '').split(/[.([]/)[0]?.trim() ?? '';
  if (title.length < 2 || title.length > 80) return null;
  return title;
}
