import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertSandboxRecipients, sandboxAllowedDomains } from '../../scripts/sandbox/lib/allowlist';
import { writeDryRun } from '../../scripts/sandbox/lib/dryRun';
import { readFixture } from '../../scripts/sandbox/lib/fixture';
import { assertVolume, generatePlan, SANDBOX_HEADER_KEY } from '../../scripts/sandbox/lib/generate';
import { buildSandboxRfc822 } from '../../scripts/sandbox/lib/rfc822';

const FIXTURE = join(process.cwd(), 'scripts', 'sandbox', 'fixtures', 'cast_deals.yaml');

describe('sandbox gmail generator (#658)', () => {
  const fixture = readFixture(FIXTURE);
  const runStart = new Date('2026-10-01T12:00:00Z');

  it('generates 200-300 messages for all deals deterministically', () => {
    const a = generatePlan({ fixture, runStart, runTag: 't1', seed: 65842 });
    const b = generatePlan({ fixture, runStart, runTag: 't1', seed: 65842 });
    assertVolume(a);
    expect(b.messages.map((m) => m.key)).toEqual(a.messages.map((m) => m.key));
    expect(a.messages[0]?.customHeaders[SANDBOX_HEADER_KEY]).toBeTruthy();
  });

  it('filters to OSPREY without deliberate mistakes', () => {
    const plan = generatePlan({ fixture, runStart, runTag: 'demo', seed: 1, dealFilter: ['OSPREY'] });
    expect(plan.messages.every((m) => m.dealCode === 'OSPREY')).toBe(true);
    expect(plan.messages.some((m) => m.tags.includes('deliberate_mistake'))).toBe(false);
  });

  it('tags trigger manifest entries with expected outcomes', () => {
    const plan = generatePlan({ fixture, runStart, runTag: 't2', seed: 99, dealFilter: ['BLUEFINCH'] });
    const bfT1 = plan.manifest.find((m) => m.triggerId === 'BF-T1');
    expect(bfT1?.expected).toBe('screening_flag');
    expect(bfT1?.tags).toContain('deliberate_mistake');
  });

  it('threads reply chains with In-Reply-To and References', () => {
    const plan = generatePlan({ fixture, runStart, runTag: 't3', seed: 7, dealFilter: ['OSPREY'] });
    const chain = plan.messages.filter((m) => m.triggerId === 'OS-T1');
    expect(chain.length).toBeGreaterThan(1);
    const replies = chain.slice(1);
    for (const reply of replies) {
      expect(reply.inReplyTo).toBeTruthy();
      expect(reply.references?.length).toBeGreaterThan(0);
    }
  });

  it('dry-run writes manifest and RFC822 payloads', async () => {
    const plan = generatePlan({ fixture, runStart, runTag: 'dry', seed: 3, dealFilter: ['TERN'] });
    assertSandboxRecipients(fixture, plan.messages);
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-mail-'));
    try {
      const result = await writeDryRun(dir, plan, 'dry');
      expect(result.messageCount).toBe(plan.messages.length);
      const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as { entries: unknown[] };
      expect(manifest.entries.length).toBe(plan.messages.length);
      const files = readdirSync(join(dir, 'messages'));
      expect(files.some((f) => f.endsWith('.eml.b64url'))).toBe(true);
      const sample = plan.messages[0]!;
      const raw = await buildSandboxRfc822(sample);
      expect(raw.length).toBeGreaterThan(50);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists only the four firm subdomains, never the bare workspace parent', () => {
    expect([...sandboxAllowedDomains()].sort()).toEqual([
      'ashgrove.conductia-sandbox.com',
      'corvane.conductia-sandbox.com',
      'halvorsen.conductia-sandbox.com',
      'thistlewood.conductia-sandbox.com',
    ]);
  });

  it('refuses addresses outside the sandbox allowed domains', () => {
    const plan = generatePlan({ fixture, runStart, runTag: 't4', seed: 1 });
    const poisoned = structuredClone(plan.messages[0]!);
    poisoned.to = [{ address: 'evil@example.com' }];
    expect(() => assertSandboxRecipients(fixture, [poisoned])).toThrow(/outside sandbox firm domains/);
  });

  it('refuses the bare conductia-sandbox.com parent domain', () => {
    const plan = generatePlan({ fixture, runStart, runTag: 't5', seed: 1 });
    const poisoned = structuredClone(plan.messages[0]!);
    poisoned.to = [{ address: 'admin@conductia-sandbox.com' }];
    expect(() => assertSandboxRecipients(fixture, [poisoned])).toThrow(/bare workspace parent/);
  });
});
