import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';

import { assertFixtureMatchesSandboxPins } from './allowlist';
import type { FixtureCastMember, SandboxFixture } from './types';

function assertObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`sandbox fixture: ${where}: expected an object`);
  }
  return value as Record<string, unknown>;
}

/** Parses the cast/deals YAML fixture (#656 / #657). */
export function parseFixture(text: string): SandboxFixture {
  const root = assertObject(parseYaml(text), 'root');
  if (root.version !== 1) throw new Error('sandbox fixture: version must be 1');
  if (!Array.isArray(root.cast) || root.cast.length === 0) throw new Error('sandbox fixture: cast required');
  if (!Array.isArray(root.deals) || root.deals.length === 0) throw new Error('sandbox fixture: deals required');
  const fixture = root as unknown as SandboxFixture;
  assertFixtureMatchesSandboxPins(fixture);
  return fixture;
}

export function readFixture(path: string): SandboxFixture {
  return parseFixture(readFileSync(path, 'utf8'));
}

export function castById(fixture: SandboxFixture): Map<string, FixtureCastMember> {
  return new Map(fixture.cast.map((c) => [c.id, c]));
}

export function castOnDeal(fixture: SandboxFixture, dealCode: string): FixtureCastMember[] {
  const deal = fixture.deals.find((d) => d.code === dealCode);
  if (!deal) throw new Error(`unknown deal ${dealCode}`);
  const ids = new Set(Object.keys(deal.cast));
  return fixture.cast.filter((c) => ids.has(c.id));
}
