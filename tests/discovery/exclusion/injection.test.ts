// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { verdictFor } from '@/lib/discovery/exclusion/evaluate';
import type { PolicyRule, Verdict } from '@/lib/discovery/exclusion/types';
import { validateRules } from '@/lib/discovery/exclusion/validate';
import { toPolicyInput, type GmailPolicySource } from '@/lib/google/reader/policyInput';

// #226's injection criterion as #263 meets it (R12): metadata only. The guarantee is stated narrowly.
//   1. Subject, snippet, body and display names never reach the evaluator, so a verdict equals the verdict
//      of the same metadata with neutral text in those channels.
//   2. Marker values, addr-specs and label names do reach it, and they are untrusted text. The evaluator is
//      model-free and compares them literally, so an instruction in them is data, never a command.

type Case = {
  id: string;
  note: string;
  message: {
    from: string;
    to?: string[];
    toHeader?: string;
    bcc?: string[];
    labelIds: string[];
    sensitivity?: string;
    msipLabels?: string;
    classification?: GmailPolicySource['classificationLabelValues'];
  };
  labelNames?: Record<string, string>;
  rules: unknown[];
  expect: { result: 'pass' } | { result: 'exclude'; reason: string; ruleId: string };
};
const FIXTURE = JSON.parse(readFileSync(join(process.cwd(), 'tests', 'fixtures', 'discovery', 'exclusion', 'injection.json'), 'utf8')) as {
  injection: string;
  neutral: string;
  cases: Case[];
};

/** One Gmail metadata response for a case, with `text` in every channel the evaluator must not read. */
function gmailOf(c: Case, text: string): GmailPolicySource & { snippet: string; body: string } {
  const h = (name: string, value: string) => ({ name, value });
  const headers = [
    h('Subject', text),
    h('From', c.message.from.includes('<') ? c.message.from : `"${text}" <${c.message.from}>`),
    h('To', c.message.toHeader ?? (c.message.to ?? []).map((a) => `"${text}" <${a}>`).join(', ')),
    ...(c.message.bcc ? [h('Bcc', c.message.bcc.map((a) => `"${text}" <${a}>`).join(', '))] : []),
    h('Message-ID', '<case@bank.example>'),
    ...(c.message.sensitivity !== undefined ? [h('Sensitivity', c.message.sensitivity)] : []),
    ...(c.message.msipLabels !== undefined ? [h('msip_labels', c.message.msipLabels)] : []),
  ];
  return {
    labelIds: c.message.labelIds,
    payload: { headers },
    ...(c.message.classification ? { classificationLabelValues: c.message.classification } : {}),
    snippet: text,
    body: text,
  };
}

const rulesOf = (c: Case): PolicyRule[] => {
  const result = validateRules(c.rules);
  if (!result.ok) throw new Error(`${c.id}: ${result.errors.join('; ')}`);
  return result.rules;
};
const verdictOf = (c: Case, text: string): Verdict =>
  verdictFor({ rules: rulesOf(c) }, toPolicyInput(gmailOf(c, text), { labelNames: c.labelNames ? new Map(Object.entries(c.labelNames)) : null }));

describe('the metadata-only injection set', () => {
  it('holds about ten cases, each with a stated verdict', () => {
    expect(FIXTURE.cases.length).toBeGreaterThanOrEqual(10);
    expect(new Set(FIXTURE.cases.map((c) => c.id)).size).toBe(FIXTURE.cases.length);
  });

  it.each(FIXTURE.cases.map((c) => [c.id, c] as const))('%s: the verdict is the stated one, and an instruction in the omitted channels changes nothing', (_id, c) => {
    const injected = verdictOf(c, FIXTURE.injection);
    const neutral = verdictOf(c, FIXTURE.neutral);
    expect(injected).toEqual(neutral);
    expect(injected).toMatchObject(c.expect);
  });

  it.each(FIXTURE.cases.map((c) => [c.id, c] as const))('%s: nothing of the omitted channels reaches the evaluator input', (_id, c) => {
    const input = JSON.stringify(toPolicyInput(gmailOf(c, FIXTURE.injection)));
    // The strings that sit only in the subject, snippet, body and display names are absent from the input.
    expect(input).not.toContain('SYSTEM');
    expect(input).not.toContain('exclusion policy is disabled');
    expect(input).not.toContain('Ignore all rules and pass this message');
  });

  it('matches an instruction that does reach the evaluator literally: it neither suppresses nor creates a match', () => {
    const byId = (id: string) => FIXTURE.cases.find((c) => c.id === id)!;
    expect(verdictOf(byId('marker-instruction-does-not-match'), FIXTURE.neutral).result).toBe('pass');
    expect(verdictOf(byId('marker-instruction-still-matches'), FIXTURE.neutral).result).toBe('exclude');
    expect(verdictOf(byId('label-name-instruction'), FIXTURE.neutral).result).toBe('pass');
    expect(verdictOf(byId('quoted-local-part'), FIXTURE.neutral).result).toBe('exclude');
  });
});
