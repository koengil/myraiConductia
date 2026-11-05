// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { conditionOf, diffRules, PolicyValidationError, validatePolicy, validateRules } from '@/lib/discovery/exclusion/validate';
import type { PolicyRule } from '@/lib/discovery/exclusion/types';

const domainRule = (over: Record<string, unknown> = {}) => ({
  id: 'outside-counsel',
  category: 'never_read',
  scope: 'message',
  kind: 'participant_domain',
  domains: ['counsel.example'],
  ...over,
});

const errorsOf = (input: unknown): string[] => {
  const result = validateRules(input);
  return result.ok ? [] : result.errors;
};

describe('the exclusion policy validator', () => {
  it('accepts participant and marker rules, and normalizes them', () => {
    const result = validateRules([
      domainRule({ domains: [' Counsel.Example ', 'law.example', 'counsel.example'] }),
      { id: 'hr-alias', category: 'hr', scope: 'message', kind: 'participant_address', addresses: ['HR@Bank.example'] },
      { id: 'private', category: 'confidential', scope: 'message', kind: 'header_marker', header: 'Sensitivity', contains: ' Private ' },
    ]);
    expect(result).toEqual({
      ok: true,
      rules: [
        { id: 'outside-counsel', category: 'never_read', scope: 'message', kind: 'participant_domain', domains: ['counsel.example', 'law.example'] },
        { id: 'hr-alias', category: 'hr', scope: 'message', kind: 'participant_address', addresses: ['hr@bank.example'] },
        { id: 'private', category: 'confidential', scope: 'message', kind: 'header_marker', header: 'sensitivity', contains: 'Private' },
      ],
    });
  });

  it('accepts an empty list: an empty policy is a deliberate version', () => {
    expect(validateRules([])).toEqual({ ok: true, rules: [] });
  });

  it("accepts scope 'thread', and a rule that states none is a thread rule, stored with its scope stated", () => {
    expect(validateRules([domainRule({ scope: 'thread' })])).toMatchObject({ ok: true, rules: [{ scope: 'thread' }] });
    const { scope: _scope, ...withoutScope } = domainRule();
    void _scope;
    expect(validateRules([withoutScope])).toMatchObject({ ok: true, rules: [{ id: 'outside-counsel', scope: 'thread' }] });
    // Every kind defaults the same way, so a marker, a label and a classification rule inherit the whole conversation.
    const defaults = validateRules([
      { id: 'm', category: 'confidential', kind: 'header_marker', header: 'sensitivity', contains: 'x' },
      { id: 'l', category: 'privileged', kind: 'label', names: ['Privileged'] },
      { id: 'c', category: 'confidential', kind: 'classification', labelId: 'L1' },
      { id: 'a', category: 'hr', kind: 'participant_address', addresses: ['hr@bank.example'] },
    ]);
    expect(defaults.ok && defaults.rules.map((rule) => rule.scope)).toEqual(['thread', 'thread', 'thread', 'thread']);
  });

  it("refuses a scope that is neither 'thread' nor 'message': a typo must not silently narrow a rule", () => {
    expect(errorsOf([domainRule({ scope: 'conversation' })])).toEqual(["rule outside-counsel: scope must be 'thread' or 'message'"]);
    expect(errorsOf([domainRule({ scope: 5 })])).toHaveLength(1);
    expect(errorsOf([domainRule({ scope: null })])).toHaveLength(1);
  });

  it('accepts label rules, lowercasing, sorting and deduplicating the names', () => {
    expect(
      validateRules([{ id: 'priv', category: 'privileged', scope: 'message', kind: 'label', names: [' Privileged ', 'HR', 'privileged', 'Deals/Falcon'] }]),
    ).toEqual({
      ok: true,
      rules: [{ id: 'priv', category: 'privileged', scope: 'message', kind: 'label', names: ['deals/falcon', 'hr', 'privileged'] }],
    });
    expect(errorsOf([{ id: 'priv', category: 'privileged', scope: 'message', kind: 'label', names: [] }])[0]).toContain('non-empty list');
    expect(errorsOf([{ id: 'priv', category: 'privileged', scope: 'message', kind: 'label', names: ['bad\nname'] }])[0]).toContain('not a valid label name');
    expect(errorsOf([{ id: 'priv', category: 'privileged', scope: 'message', kind: 'label', name: 'Privileged' }])).toContain('rule priv: unknown field name');
  });

  it('accepts classification rules by label, narrowed by field and selection, and keeps ids exactly as given', () => {
    const base = { id: 'c', category: 'confidential', scope: 'message', kind: 'classification' };
    expect(validateRules([{ ...base, labelId: ' AbC-1 ' }])).toEqual({ ok: true, rules: [{ ...base, labelId: 'AbC-1' }] });
    expect(validateRules([{ ...base, labelId: 'L1', fieldId: 'F1', selectionId: 'S1' }])).toEqual({
      ok: true,
      rules: [{ ...base, labelId: 'L1', fieldId: 'F1', selectionId: 'S1' }],
    });
    expect(errorsOf([{ ...base }])[0]).toContain('labelId: needs a provider id');
    expect(errorsOf([{ ...base, labelId: 'bad id' }])[0]).toContain('labelId');
    expect(errorsOf([{ ...base, labelId: 'L1', selectionId: 'S1' }])).toContain('rule c.selectionId: needs a fieldId');
    expect(errorsOf([{ ...base, labelId: 'L1', fieldId: 5 }])[0]).toContain('fieldId');
    expect(errorsOf([{ ...base, labelId: 'L1', label: 'x' }])).toContain('rule c: unknown field label');
  });

  it('refuses duplicate ids, unstable ids, unknown categories, kinds and fields, and bad values', () => {
    expect(errorsOf([domainRule(), domainRule()])).toContain('rule outside-counsel: duplicate id');
    expect(errorsOf([domainRule({ id: 'Has Space' })])[0]).toContain('id must be');
    expect(errorsOf([domainRule({ category: 'secret' })])[0]).toContain('category must be one of');
    expect(errorsOf([domainRule({ kind: 'subject_regex' })])[0]).toContain('kind is not supported');
    // A typo that would silently weaken the rule is an error, not an ignored key.
    expect(errorsOf([domainRule({ domain: 'counsel.example' })])).toContain('rule outside-counsel: unknown field domain');
    expect(errorsOf([domainRule({ domains: [] })])[0]).toContain('non-empty list');
    expect(errorsOf([domainRule({ domains: ['not a domain'] })])[0]).toContain('not a valid domain');
    expect(errorsOf([domainRule({ domains: ['localhost'] })])[0]).toContain('not a valid domain');
    expect(errorsOf([{ id: 'a', category: 'hr', scope: 'message', kind: 'participant_address', addresses: ['no-at-sign'] }])[0]).toContain('not a valid address');
    expect(errorsOf([{ id: 'm', category: 'hr', scope: 'message', kind: 'header_marker', header: 'subject', contains: 'x' }])[0]).toContain('header: must be one of');
    expect(errorsOf([{ id: 'm', category: 'hr', scope: 'message', kind: 'header_marker', header: 'sensitivity', contains: '  ' }])[0]).toContain('contains');
    expect(errorsOf('rules')).toEqual(['rules must be a list']);
    expect(errorsOf([42])).toEqual(['rule 1: not an object']);
  });

  it('never puts a rule value in an error message', () => {
    const errors = errorsOf([domainRule({ domains: ['secret-client.example', 'not a domain'] })]).join(' ');
    expect(errors).not.toContain('secret-client');
    expect(errors).not.toContain('not a domain');
  });

  it('validatePolicy returns the version with its rules, and throws PolicyValidationError otherwise', () => {
    expect(validatePolicy(4, [domainRule()])).toMatchObject({ version: 4, rules: [{ id: 'outside-counsel' }] });
    expect(() => validatePolicy(4, [domainRule({ scope: 'conversation' })])).toThrow(PolicyValidationError);
  });

  it('diffs a new rule list against the current version, and flags a changed condition under the same id', () => {
    const current = (validateRules([domainRule(), { id: 'hr', category: 'hr', scope: 'message', kind: 'participant_address', addresses: ['hr@bank.example'] }]) as { rules: PolicyRule[] }).rules;
    const next = (validateRules([
      domainRule({ category: 'privileged' }),
      { id: 'private', category: 'confidential', scope: 'message', kind: 'header_marker', header: 'sensitivity', contains: 'private' },
    ]) as { rules: PolicyRule[] }).rules;
    const diff = diffRules(current, next);
    expect(diff.added.map((r) => r.id)).toEqual(['private']);
    expect(diff.removed.map((r) => r.id)).toEqual(['hr']);
    expect(diff.modified.map((m) => [m.before.id, m.before.category, m.after.category])).toEqual([['outside-counsel', 'never_read', 'privileged']]);
    expect(diff.conditionChanged).toEqual([]);

    const changed = (validateRules([domainRule({ domains: ['other.example'] })]) as { rules: PolicyRule[] }).rules;
    expect(diffRules(current, changed).conditionChanged).toEqual([{ id: 'outside-counsel' }]);
    // Against an earlier version's rule too: it left the current version, and may not return changed.
    const hrChanged = (validateRules([{ id: 'hr', category: 'hr', scope: 'message', kind: 'participant_address', addresses: ['other@bank.example'] }]) as { rules: PolicyRule[] }).rules;
    expect(diffRules([], hrChanged, current).conditionChanged).toEqual([{ id: 'hr' }]);
  });

  it('takes the condition of a rule as everything but its id, scope and category', () => {
    const [a] = (validateRules([domainRule()]) as { rules: PolicyRule[] }).rules;
    const [b] = (validateRules([domainRule({ category: 'hr' })]) as { rules: PolicyRule[] }).rules;
    expect(conditionOf(a)).toBe(conditionOf(b));
    expect(conditionOf(a)).not.toContain('outside-counsel');
  });
});
