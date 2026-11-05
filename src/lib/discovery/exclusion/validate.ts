// Validates a policy's rules (#263): the stored jsonb, or the operator's input,
// into typed, normalized rules. Strict on purpose: an unknown key, kind, scope or
// category is an error, because a typo that silently weakened a rule (`domain`
// for `domains`) would read mail the bank meant to exclude.
//
// Normalization makes a rule's condition canonical (lowercased, trimmed, sorted,
// deduplicated), so the same condition always serializes the same way: the
// database refuses a changed condition under an existing id
// (rule_condition_changed), and a reordered domain list must not count as one.
//
// A rule without a `scope` is a thread rule (design Q1: privilege attaches to the
// conversation), and the normalized rule always states it, so every stored version
// says what it does. The recommended counsel rule is stated 'message' on purpose.

import {
  MARKER_HEADERS,
  RULE_CATEGORIES,
  type ExclusionPolicy,
  type MarkerHeader,
  type PolicyRule,
  type RuleCategory,
  type RuleScope,
} from './types';

/** The kinds and scopes this build enforces. */
export const ACCEPTED_KINDS: ReadonlySet<string> = new Set([
  'participant_domain',
  'participant_address',
  'header_marker',
  'label',
  'classification',
]);
export const ACCEPTED_SCOPES: ReadonlySet<string> = new Set(['thread', 'message']);
/** The scope of a rule that states none. */
export const DEFAULT_SCOPE = 'thread' as const;

export const MAX_RULES = 200;
const MAX_VALUES_PER_RULE = 500;
const MAX_MARKER_LENGTH = 200;
const RULE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
// A label name as Gmail allows one (up to 225 characters, any text but control characters), and an opaque provider id.
const LABEL_NAME = /^[^\u0000-\u001f\u007f]{1,225}$/;
const OPAQUE_ID = /^[A-Za-z0-9_.:=+/-]{1,200}$/;
const ADDR_SPEC = /^[^\s@<>"(),;:\\]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export type RulesResult = { ok: true; rules: PolicyRule[] } | { ok: false; errors: string[] };

/** The operator's or the database's rules are not a valid policy. Its message names rule ids and fields, never a value. */
export class PolicyValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(`exclusion policy is invalid: ${errors.join('; ')}`);
    this.name = 'PolicyValidationError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function stringList(value: unknown, at: string, errors: string[], pattern: RegExp, what: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${at}: needs a non-empty list of ${what}`);
    return [];
  }
  if (value.length > MAX_VALUES_PER_RULE) errors.push(`${at}: more than ${MAX_VALUES_PER_RULE} ${what}`);
  const out = new Set<string>();
  for (const entry of value) {
    const normalized = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    if (!pattern.test(normalized)) errors.push(`${at}: a value is not a valid ${what.replace(/s$/, '')}`);
    else out.add(normalized);
  }
  return [...out].sort();
}

/** An opaque provider id (a classification label, field or selection), kept as given: ids are compared exactly. */
function opaqueId(value: unknown, at: string, errors: string[], required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  const id = typeof value === 'string' ? value.trim() : '';
  if (!OPAQUE_ID.test(id)) {
    errors.push(`${at}: ${required ? 'needs' : 'must be'} a provider id (1 to 200 letters, digits or . _ : = + / -)`);
    return undefined;
  }
  return id;
}

function checkKeys(rule: Record<string, unknown>, allowed: readonly string[], at: string, errors: string[]): void {
  for (const key of Object.keys(rule)) if (!allowed.includes(key)) errors.push(`${at}: unknown field ${key}`);
}

/** The typed, normalized rules, or every error found. Never throws. */
export function validateRules(input: unknown): RulesResult {
  const errors: string[] = [];
  if (!Array.isArray(input)) return { ok: false, errors: ['rules must be a list'] };
  if (input.length > MAX_RULES) errors.push(`more than ${MAX_RULES} rules`);

  const rules: PolicyRule[] = [];
  const seen = new Set<string>();
  input.forEach((raw, index) => {
    if (!isRecord(raw)) {
      errors.push(`rule ${index + 1}: not an object`);
      return;
    }
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const at = id && RULE_ID.test(id) ? `rule ${id}` : `rule ${index + 1}`;
    if (!RULE_ID.test(id)) errors.push(`${at}: id must be lowercase letters, digits, - or _ (1 to 64 characters)`);
    else if (seen.has(id)) errors.push(`${at}: duplicate id`);
    else seen.add(id);

    const category = raw.category;
    if (typeof category !== 'string' || !(RULE_CATEGORIES as readonly string[]).includes(category)) {
      errors.push(`${at}: category must be one of ${RULE_CATEGORIES.join(', ')}`);
    }
    // A missing scope is the default; a stated one must be a known scope (a typo must not silently narrow a rule).
    if (raw.scope !== undefined && (typeof raw.scope !== 'string' || !ACCEPTED_SCOPES.has(raw.scope))) {
      errors.push(`${at}: scope must be 'thread' or 'message'`);
    }

    const kind = raw.kind;
    if (typeof kind !== 'string' || !ACCEPTED_KINDS.has(kind)) {
      errors.push(`${at}: kind is not supported yet`);
      return;
    }
    const head = { id, category: category as RuleCategory, scope: (raw.scope ?? DEFAULT_SCOPE) as RuleScope };
    switch (kind) {
      case 'participant_domain': {
        checkKeys(raw, ['id', 'category', 'scope', 'kind', 'domains'], at, errors);
        rules.push({ ...head, kind, domains: stringList(raw.domains, `${at}.domains`, errors, DOMAIN, 'domains') });
        break;
      }
      case 'participant_address': {
        checkKeys(raw, ['id', 'category', 'scope', 'kind', 'addresses'], at, errors);
        rules.push({ ...head, kind, addresses: stringList(raw.addresses, `${at}.addresses`, errors, ADDR_SPEC, 'addresses') });
        break;
      }
      case 'header_marker': {
        checkKeys(raw, ['id', 'category', 'scope', 'kind', 'header', 'contains'], at, errors);
        const header = typeof raw.header === 'string' ? raw.header.trim().toLowerCase() : '';
        if (!(MARKER_HEADERS as readonly string[]).includes(header)) errors.push(`${at}.header: must be one of ${MARKER_HEADERS.join(', ')}`);
        const contains = typeof raw.contains === 'string' ? raw.contains.trim() : '';
        if (contains === '' || contains.length > MAX_MARKER_LENGTH) {
          errors.push(`${at}.contains: needs 1 to ${MAX_MARKER_LENGTH} characters`);
        }
        rules.push({ ...head, kind, header: header as MarkerHeader, contains });
        break;
      }
      case 'label': {
        checkKeys(raw, ['id', 'category', 'scope', 'kind', 'names'], at, errors);
        // Names are matched case-insensitively, so they are stored lowercased.
        rules.push({ ...head, kind, names: stringList(raw.names, `${at}.names`, errors, LABEL_NAME, 'label names') });
        break;
      }
      case 'classification': {
        checkKeys(raw, ['id', 'category', 'scope', 'kind', 'labelId', 'fieldId', 'selectionId'], at, errors);
        const labelId = opaqueId(raw.labelId, `${at}.labelId`, errors, true);
        const fieldId = opaqueId(raw.fieldId, `${at}.fieldId`, errors, false);
        const selectionId = opaqueId(raw.selectionId, `${at}.selectionId`, errors, false);
        // A selection belongs to a field: a selection alone would name nothing the provider returns.
        if (selectionId !== undefined && fieldId === undefined && raw.fieldId === undefined) {
          errors.push(`${at}.selectionId: needs a fieldId`);
        }
        rules.push({
          ...head,
          kind,
          labelId: labelId ?? '',
          ...(fieldId !== undefined ? { fieldId } : {}),
          ...(selectionId !== undefined ? { selectionId } : {}),
        });
        break;
      }
    }
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, rules };
}

/** A policy version from stored rules; throws PolicyValidationError when they are not valid. */
export function validatePolicy(version: number, input: unknown): ExclusionPolicy {
  const result = validateRules(input);
  if (!result.ok) throw new PolicyValidationError(result.errors);
  return { version, rules: result.rules };
}

/**
 * The condition of a rule: everything but its id, scope and category. A rule id
 * names one condition forever (the database enforces it), so this is what a
 * diff compares to say "this rule changed its condition, give it a new id".
 */
export function conditionOf(rule: PolicyRule): string {
  const condition: Record<string, unknown> = { ...rule };
  delete condition.id;
  delete condition.scope;
  delete condition.category;
  return JSON.stringify(Object.fromEntries(Object.entries(condition).sort(([a], [b]) => (a < b ? -1 : 1))));
}

export type RuleDiff = {
  added: PolicyRule[];
  removed: PolicyRule[];
  /** Same id and condition, but the scope or category differs: a narrowing or widening, a new version like any other. */
  modified: Array<{ before: PolicyRule; after: PolicyRule }>;
  /** Same id as an earlier version's rule but a different condition: refused, because an id names one condition forever. */
  conditionChanged: Array<{ id: string }>;
  unchanged: number;
};

/**
 * What a new rule list changes against the current version. `earlier` is every
 * rule any earlier version held (the database refuses a changed condition against
 * any of them, not only the current one), so the operator sees the refusal before it.
 */
export function diffRules(current: readonly PolicyRule[], next: readonly PolicyRule[], earlier: readonly PolicyRule[] = current): RuleDiff {
  const currentById = new Map(current.map((rule) => [rule.id, rule]));
  const conditionsEver = new Map<string, Set<string>>();
  for (const rule of [...earlier, ...current]) {
    const set = conditionsEver.get(rule.id) ?? new Set<string>();
    set.add(conditionOf(rule));
    conditionsEver.set(rule.id, set);
  }
  const diff: RuleDiff = { added: [], removed: [], modified: [], conditionChanged: [], unchanged: 0 };
  for (const rule of next) {
    const held = conditionsEver.get(rule.id);
    if (held && !held.has(conditionOf(rule))) {
      diff.conditionChanged.push({ id: rule.id });
      continue;
    }
    const before = currentById.get(rule.id);
    if (!before) diff.added.push(rule);
    else if (before.scope !== rule.scope || before.category !== rule.category) diff.modified.push({ before, after: rule });
    else diff.unchanged += 1;
  }
  const nextIds = new Set(next.map((rule) => rule.id));
  diff.removed = current.filter((rule) => !nextIds.has(rule.id));
  return diff;
}
