import { expect, test } from '@playwright/test';

import { MAILBOX_PROVIDER, SOURCE_KIND } from '@/lib/constants/discovery';
import { TABLE } from '@/lib/constants/tables';
import { DEV_TENANT_ID } from '@/lib/db/tenant';

import { DEMO_POLICY_REQUESTED_BY } from '../../scripts/discovery/lib/demoPolicyRequester';
import { serviceClient } from './discoveryEvidence';

/**
 * Which mail path the discovery demo journey seeds, from the Playwright project's metadata (playwright.config.ts).
 * Missing or unknown is refused: a project that forgot it must fail, not run the Graph path and pass.
 */
export const MAIL_PATHS = ['graph', 'gmail-replay'] as const;
export type MailPath = (typeof MAIL_PATHS)[number];

const PROVIDER_OF: Record<MailPath, string> = {
  graph: MAILBOX_PROVIDER.MICROSOFT,
  'gmail-replay': MAILBOX_PROVIDER.GOOGLE,
};

export function mailPath(): MailPath {
  const value: unknown = test.info().project.metadata?.mailPath;
  if (!MAIL_PATHS.includes(value as MailPath)) {
    throw new Error(`the discovery demo needs project metadata mailPath (${MAIL_PATHS.join(' | ')}), got ${String(value)}`);
  }
  return value as MailPath;
}

/** Why these mailbox sources are not on `path`, or null when every one is. An empty tenant is refused too. */
export function mailPathRefusal(path: MailPath, rows: ReadonlyArray<{ address: string; provider: string }>): string | null {
  if (rows.length === 0) return 'the seed placed no mailbox sources';
  const offPath = rows.filter((r) => r.provider !== PROVIDER_OF[path]).map((r) => `${r.address}: ${r.provider}`);
  return offPath.length > 0 ? offPath.join(', ') : null;
}

/**
 * Every live mailbox source of the dev tenant is on this project's path: the journey cannot pass on the wrong one.
 * On the Gmail replay the seed also wrote an audited exclusion policy row (v1 or later) before it classified.
 * Called first in beat 1's act (before any mutation), and again after each mid-journey re-seed.
 */
export async function assertSeededMailPath(): Promise<void> {
  const path = mailPath();
  const { data, error } = await serviceClient()
    .from(TABLE.CONTENT_SOURCES)
    .select('address, provider')
    .eq('tenant_id', DEV_TENANT_ID)
    .eq('kind', SOURCE_KIND.MAILBOX)
    .is('archived_at', null);
  expect(error, 'read the dev tenant mailbox sources').toBeNull();
  const rows = (data ?? []) as Array<{ address: string; provider: string }>;
  expect(mailPathRefusal(path, rows), `every mailbox source is on the ${path} path`).toBeNull();

  const policies = await serviceClient()
    .from(TABLE.DISCOVERY_EXCLUSION_POLICIES)
    .select('version, requested_by')
    .eq('tenant_id', DEV_TENANT_ID)
    .order('version', { ascending: false })
    .limit(1);
  expect(policies.error, 'read the dev tenant exclusion policy').toBeNull();
  const [latest] = (policies.data ?? []) as Array<{ version: number; requested_by: string }>;
  if (path === 'gmail-replay') {
    // The seed wrote an audited policy row before it classified. This proves the write, not that the pass applied
    // it: with [] nothing is skipped, so no ledger row carries policy_version (D4). #338's tests hold the read path.
    expect(latest?.version ?? 0, 'the seed wrote a stored exclusion policy').toBeGreaterThanOrEqual(1);
    expect(latest?.requested_by).toBe(DEMO_POLICY_REQUESTED_BY);
  } else {
    expect(latest, 'the Graph path seeds no exclusion policy (#263 R9)').toBeUndefined();
  }
}
