import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';

import { GRAPH_READER_PROVIDER } from '@/lib/graph/reader';
import { collectExport, writeExport, type DiscoveryExport } from '../../scripts/discovery-export';
import { fixtureMailboxes } from '../discovery/fixtureInnerReader';
import { runOnce } from '../../worker/classify';
import {
  createGuardedTenant,
  dropGuardedTenant,
  enableDiscoveryFlag,
  optInOwners,
  registerFixtureReader,
  type GuardedTenant,
  type GuardedTenantEnv,
} from './support/guardedTenant';

/*
 * The eval export (phase 5) against a REAL database: the fixture corpus is
 * classified into a throwaway tenant, a second throwaway tenant gets one of
 * the same mailboxes, and the export of the first must hold exactly the
 * first tenant's rows, with no text, subject or participant from the corpus.
 *
 * Every read goes through the guard (#262), so each tenant is set up the way
 * the allowlist admits a mailbox: a bank company, a registration naming it and
 * the mail domain, an accepted invite per mailbox, each owner's own opt-in under
 * their session (which creates the mailbox source, C20), and deal_discovery on.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  throw new Error('The discovery export test needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (local stack).');
}
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!publishable) {
  throw new Error('The discovery export test needs NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (local stack).');
}
const db = createClient(url, secret, { auth: { persistSession: false } });

const RUN = Date.now().toString(36);
const env: GuardedTenantEnv = { db, url, publishableKey: publishable, run: RUN, password: `Export-${RUN}-x9!` };
const MAILBOXES = ['storm.duncan@bank.example', 'morgan.vale@bank.example', 'alex.chen@bank.example'];

let TENANT = '';
const tenants: GuardedTenant[] = [];
let restoreFlag: () => Promise<void> = async () => undefined;

async function setUp(label: string, mailboxes: string[]): Promise<GuardedTenant> {
  const tenant = await createGuardedTenant(env, label, mailboxes);
  tenants.push(tenant);
  await registerFixtureReader(env, tenant);
  await optInOwners(tenant);
  return tenant;
}

let data: DiscoveryExport;

beforeAll(async () => {
  restoreFlag = await enableDiscoveryFlag(db);
  const own = await setUp('export', MAILBOXES);
  TENANT = own.id;
  const neighbour = await setUp('export-neighbour', [MAILBOXES[0]]);
  for (const tenantId of [own.id, neighbour.id]) {
    const summary = await runOnce({ tenantId, db, provider: GRAPH_READER_PROVIDER.FIXTURE });
    if (summary.status !== 'ok') throw new Error(`classification skipped for ${tenantId}`);
    if (summary.refused.length > 0) throw new Error(`the guard refused ${summary.refused.length} source(s) for ${tenantId}`);
  }
  data = await collectExport(db, TENANT);
}, 120_000);

afterAll(async () => {
  for (const tenant of tenants) await dropGuardedTenant(env, tenant);
  await restoreFlag();
});

describe('discovery:export', () => {
  it('exports the tenant\'s discovery state, and only that tenant\'s', async () => {
    expect({
      sources: data.sources.length,
      ledger: data.ledger.length,
      items: data.items.length,
      provenance: data.provenance.length,
      candidates: data.candidates.length,
      links: data.links.length,
    }).toEqual({ sources: 3, ledger: 17, items: 8, provenance: 10, candidates: 2, links: 8 });

    const { data: own } = await db.from('content_sources').select('id').eq('tenant_id', TENANT);
    const ownSources = new Set((own ?? []).map((r) => r.id as string));
    expect(data.ledger.every((r) => ownSources.has(r.sourceId))).toBe(true);
    expect(data.provenance.every((r) => ownSources.has(r.sourceId))).toBe(true);
    const ownItems = new Set(data.items.map((i) => i.id));
    expect(data.links.every((l) => ownItems.has(l.sourceItemId))).toBe(true);
    expect(data.candidates.map((c) => c.proposedName).sort()).toEqual(['Project Cobra', 'Project Falcon']);
  });

  it('keeps the Message-ID and conversation of every unrouted message, for the recall buckets', () => {
    const unrouted = data.ledger.filter((r) => r.decision === 'unrouted');
    expect(unrouted).toHaveLength(7);
    expect(unrouted.every((r) => r.internetMessageId && r.conversationId)).toBe(true);
    expect(unrouted.map((r) => r.internetMessageId)).toContain('<dinner-005@heliotrope.example>');
    const routed = data.ledger.filter((r) => r.decision === 'routed');
    expect(routed.every((r) => r.internetMessageId === null)).toBe(true);
  });

  it('holds no body text, subject or participant from the corpus', () => {
    const json = JSON.stringify(data);
    const messages = fixtureMailboxes().flatMap((m) => m.messages);
    for (const message of messages) {
      const body = message.body.content.replace(/<[^>]+>/g, ' ');
      for (const phrase of body.split(/[.\n]/).map((s) => s.trim()).filter((s) => s.length > 20)) {
        expect(json).not.toContain(phrase);
      }
      if (message.subject) expect(json).not.toContain(`"${message.subject}"`);
      for (const r of [message.from, ...message.toRecipients, ...message.ccRecipients]) {
        if (r) expect(json).not.toContain(r.emailAddress.address);
      }
    }
    expect(json).not.toContain('kicks off next week');
  });

  it('writes files the harness reads, owner-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-export-it-'));
    try {
      const manifest = writeExport(dir, TENANT, data, new Date().toISOString());
      expect(readdirSync(dir).sort()).toEqual([
        'candidates.jsonl',
        'items.jsonl',
        'ledger.jsonl',
        'links.jsonl',
        'manifest.json',
        'provenance.jsonl',
        'sources.jsonl',
      ]);
      const lines = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(manifest.counts['ledger.jsonl']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
