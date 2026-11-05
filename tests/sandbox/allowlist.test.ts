import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertSandboxRecipients, sandboxAllowedDomains } from '../../scripts/sandbox/lib/allowlist';
import {
  SANDBOX_FIRM_MAIL_DOMAINS,
  SANDBOX_WORKSPACE_DOMAIN,
  assertSandboxMailAddress,
} from '../../scripts/sandbox/lib/domains';
import { parseFixture } from '../../scripts/sandbox/lib/fixture';
import { generatePlan } from '../../scripts/sandbox/lib/generate';
import type { SandboxFixture } from '../../scripts/sandbox/lib/types';

const FIXTURE_PATH = join(process.cwd(), 'scripts', 'sandbox', 'fixtures', 'cast_deals.yaml');

describe('sandbox mail allow-list (hardcoded #746)', () => {
  it('pins the workspace parent and four firm subdomains', () => {
    expect(SANDBOX_WORKSPACE_DOMAIN).toBe('conductia-sandbox.com');
    expect([...SANDBOX_FIRM_MAIL_DOMAINS].sort()).toEqual([...sandboxAllowedDomains()].sort());
  });

  it('rejects the bare parent and outside domains', () => {
    expect(() => assertSandboxMailAddress('admin@conductia-sandbox.com')).toThrow(/bare workspace parent/);
    expect(() => assertSandboxMailAddress('x@gmail.com')).toThrow(/outside sandbox firm domains/);
    expect(() => assertSandboxMailAddress('victoria.lang@halvorsen.conductia-sandbox.com')).not.toThrow();
  });

  it('rejects a hostile fixture at parse time', () => {
    const good = readFileSync(FIXTURE_PATH, 'utf8');
    expect(() => parseFixture(good.replace(SANDBOX_WORKSPACE_DOMAIN, 'gmail.com'))).toThrow(/domain must be/);
    expect(() =>
      parseFixture(good.replace('halvorsen.conductia-sandbox.com', 'evil.example.com')),
    ).toThrow(/must be one of the sandbox firm domains/);
  });

  it('rejects generated mail when addresses are poisoned after generation', () => {
    const fixture = parseFixture(readFileSync(FIXTURE_PATH, 'utf8'));
    const plan = generatePlan({
      fixture,
      runStart: new Date('2026-10-01T12:00:00Z'),
      runTag: 'hostile',
      seed: 1,
    });
    const poisoned = structuredClone(plan.messages[0]!);
    poisoned.to = [{ address: 'notallowed@gmail.com' }];
    expect(() => assertSandboxRecipients(fixture, [poisoned])).toThrow(/outside sandbox firm domains/);
  });
});
