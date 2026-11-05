// @vitest-environment node
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { validateRules } from '@/lib/discovery/exclusion/validate';

import { classificationWarnings, parseArgs, RECOMMENDED_TEMPLATE, run } from '../../scripts/discovery/set-exclusion-policy';

const TENANT = '11111111-1111-4111-8111-111111111111';
const COUNSEL = { id: 'outside-counsel', category: 'never_read', scope: 'message', kind: 'participant_domain', domains: ['counsel.example'] };

function rulesFile(rules: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), 'policy-')), 'rules.json');
  writeFileSync(file, JSON.stringify(rules));
  return file;
}

/** A fake service client: the tenant's versions (newest first), and the RPC that would write the next. */
function fakeDb(versions: Array<{ version: number; rules: unknown }>, rpcAnswer: { data?: unknown; error?: { message: string } } = { data: 2 }) {
  const rpc = vi.fn(async () => ({ data: rpcAnswer.data ?? null, error: rpcAnswer.error ?? null }));
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    order: () => Promise.resolve({ data: versions, error: null }),
  };
  return { db: { from: () => builder, rpc } as unknown as SupabaseClient, rpc };
}

const argv = (file: string, extra: string[] = [], expected = '1') => [
  '--tenant', TENANT, '--requested-by', 'Jordan Ames, CCO', '--expected-version', expected, '--rules', file, ...extra,
];

describe('the exclusion policy operator script', () => {
  it('needs a tenant, a requester, an expected version and a rules file', () => {
    expect(() => parseArgs([])).toThrow('--tenant');
    expect(() => parseArgs(['--tenant', TENANT])).toThrow('--requested-by');
    expect(() => parseArgs(['--tenant', TENANT, '--requested-by', 'x'])).toThrow('--expected-version');
    expect(() => parseArgs(['--tenant', TENANT, '--requested-by', 'x', '--expected-version', 'one'])).toThrow('--expected-version');
    expect(() => parseArgs(['--tenant', TENANT, '--requested-by', 'x', '--expected-version', '0'])).toThrow('--rules');
    expect(parseArgs(argv('f.json', ['--confirm']))).toMatchObject({ tenant: TENANT, expectedVersion: 1, confirm: true });
  });

  it('refuses a blank requester: the audit row is a service row, and this is its only record of who asked', () => {
    for (const blank of ['', '   ']) {
      expect(() => parseArgs(['--tenant', TENANT, '--requested-by', blank, '--expected-version', '0', '--rules', 'f.json'])).toThrow('--requested-by');
    }
  });

  it('warns, without refusing, when a classification rule is set while the Gmail classification field is unverified', async () => {
    const restricted = { id: 'restricted', category: 'confidential', scope: 'message', kind: 'classification', labelId: 'conf-label-1' };
    const { db, rpc } = fakeDb([{ version: 1, rules: [] }], { data: 2 });
    const lines: string[] = [];
    expect(await run(argv(rulesFile([COUNSEL, restricted]), ['--confirm']), db, (line) => lines.push(line))).toBe(0);
    expect(rpc).toHaveBeenCalledTimes(1);
    const warnings = lines.filter((line) => line.startsWith('warning:'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('rule restricted is a classification rule');
    expect(warnings[0]).not.toMatch(/[\u2013\u2014]/);
    // Once the field is verified, nothing to say; and a policy with no classification rule never warns.
    const parsed = validateRules([COUNSEL, restricted]);
    expect(parsed.ok && classificationWarnings(parsed.rules, true)).toEqual([]);
    const plain = validateRules([COUNSEL]);
    expect(plain.ok && classificationWarnings(plain.rules)).toEqual([]);
  });

  it('prints the diff and writes nothing without --confirm', async () => {
    const { db, rpc } = fakeDb([{ version: 1, rules: [] }]);
    const lines: string[] = [];
    const code = await run(argv(rulesFile([COUNSEL])), db, (line) => lines.push(line));
    expect(code).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('Version 1 -> 2, requested by Jordan Ames, CCO');
    expect(lines.join('\n')).toContain('+ outside-counsel [participant_domain, never_read, message] counsel.example');
    expect(lines.join('\n')).toContain('Dry run: nothing written');
  });

  it('writes the version through the RPC with --confirm, naming the requester and the expected version', async () => {
    const { db, rpc } = fakeDb([{ version: 1, rules: [] }], { data: 2 });
    const lines: string[] = [];
    expect(await run(argv(rulesFile([COUNSEL]), ['--confirm']), db, (line) => lines.push(line))).toBe(0);
    expect(rpc).toHaveBeenCalledWith('discovery_exclusion_policy_set', {
      p_tenant_id: TENANT,
      p_rules: [COUNSEL],
      p_expected_version: 1,
      p_requested_by: 'Jordan Ames, CCO',
    });
    expect(lines).toContain('Wrote version 2.');
  });

  it('refuses a stale expected version without calling the RPC', async () => {
    const { db, rpc } = fakeDb([{ version: 3, rules: [] }]);
    const lines: string[] = [];
    expect(await run(argv(rulesFile([COUNSEL]), ['--confirm'], '1'), db, (line) => lines.push(line))).toBe(1);
    expect(rpc).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain("current version is 3, not 1");
  });

  it('refuses invalid rules, and a rule that changes its condition under an existing id, before any write', async () => {
    const bad = fakeDb([{ version: 1, rules: [] }]);
    const lines: string[] = [];
    expect(await run(argv(rulesFile([{ ...COUNSEL, scope: 'conversation' }]), ['--confirm']), bad.db, (line) => lines.push(line))).toBe(1);
    expect(lines.join('\n')).toContain('invalid:');
    expect(bad.rpc).not.toHaveBeenCalled();

    const held = fakeDb([{ version: 1, rules: [COUNSEL] }]);
    const changed = { ...COUNSEL, domains: ['other.example'] };
    const out: string[] = [];
    expect(await run(argv(rulesFile([changed]), ['--confirm']), held.db, (line) => out.push(line))).toBe(1);
    expect(out.join('\n')).toContain('changes its condition');
    expect(held.rpc).not.toHaveBeenCalled();
  });

  it('prints the recommended template with --print-template, writes nothing, and needs no tenant or database', async () => {
    const lines: string[] = [];
    expect(await run(['--print-template'], undefined, (line) => lines.push(line))).toBe(0);
    expect(JSON.parse(lines.join('\n'))).toEqual(RECOMMENDED_TEMPLATE);
  });

  it('keeps the template valid: markers and labels are thread rules, the outside-counsel domain a message rule', () => {
    const result = validateRules(RECOMMENDED_TEMPLATE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scopes = Object.fromEntries(result.rules.map((rule) => [rule.id, rule.scope]));
    expect(scopes['outside-counsel']).toBe('message');
    expect(Object.entries(scopes).filter(([id]) => id !== 'outside-counsel').every(([, scope]) => scope === 'thread')).toBe(true);
    expect(result.rules.map((rule) => rule.kind)).toEqual(
      expect.arrayContaining(['header_marker', 'label', 'participant_domain']),
    );
    // The label rules name Privileged, Confidential and HR, as the bank's mailbox labels them.
    const names = result.rules.flatMap((rule) => (rule.kind === 'label' ? rule.names : []));
    expect(names.sort()).toEqual(['confidential', 'hr', 'privileged']);
  });

  it('writes an explicit empty policy: a live tenant needs one deliberate version', async () => {
    const { db, rpc } = fakeDb([], { data: 1 });
    expect(await run(argv(rulesFile([]), ['--confirm'], '0'), db, () => undefined)).toBe(0);
    expect(rpc).toHaveBeenCalledWith('discovery_exclusion_policy_set', expect.objectContaining({ p_rules: [], p_expected_version: 0 }));
  });

  it('reports the database refusing a write (a concurrent change) instead of claiming success', async () => {
    const { db } = fakeDb([{ version: 1, rules: [] }], { error: { message: 'stale_version' } });
    const lines: string[] = [];
    expect(await run(argv(rulesFile([COUNSEL]), ['--confirm']), db, (line) => lines.push(line))).toBe(1);
    expect(lines.join('\n')).toContain('refused: stale_version');
    expect(lines.join('\n')).not.toContain('Wrote');
  });
});
