import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';

/*
 * The exclusion policy and the two-step read, against a REAL database (#263, Phase 1):
 *
 *   policy version (the audited RPC) -> runOnce (the worker) -> the guard wrapper -> the real Gmail
 *   ContentSource over a replay -> persistItems -> routing_ledger / source_items.
 *
 * What is real: the worker, the guard, the policy loader, the Gmail reader (in fixture mode, over a
 * replay built here from a few synthetic messages), persistence, the RPCs and Postgres. Nothing
 * contacts Google. The mail names a deal codename (Project Osprey) in every message, so a message the
 * policy did not exclude would be routed and stored: the excluded ones prove the policy, not the router.
 *
 * It proves, in one story for one mailbox:
 *   - a live tenant with no policy, or an invalid one, is refused with a fixed Last error in BOTH
 *     worker paths (runOnce and the queued sync handler), before any request;
 *   - an excluded message has one ledger row (skipped, a policy reason, rule, version, thread id, a
 *     metadata hash) and no source_items or source_item_texts row, and no text of it is stored;
 *   - a later version applies to later passes;
 *   - a policy skip never replaces an earlier read: a message stored under one version, then matched by a
 *     rule of the next and re-backfilled after an expired cursor, stays routed with its method and hash,
 *     and a message ledgered id_collision keeps its reason and distances;
 *   - (phase 2) a label rule over a mailbox with a user label: the labelled message is skipped before its fetch,
 *     a message whose label arrived between the metadata and the raw read is ledgered
 *     policy_excluded_after_fetch (fetched, discarded unparsed, never stored), and a later re-backfill under a
 *     rule that would now exclude it at metadata time leaves that row unchanged.
 *
 *   - (phase 3) thread scope across passes: a thread rule excludes an unlabelled reply that arrives in a later pass,
 *     a message stored before its thread was tainted stays stored (and one join finds it), an expired cursor's
 *     re-backfill never turns it into a policy skip, a reordered policy cannot erase a taint, and narrowing the
 *     rule to message scope stops the old taint.
 *
 * Self-contained: a throwaway tenant, bank, mailbox owner, Google registration and deal. Discovery rows are
 * deleted afterwards; policy versions and audit rows stay (both are append-only, on a throwaway local stack).
 */

import { READER_MODE } from '@/lib/constants/discovery';
import { createFixtureAllowlistMirror } from '@/lib/mailboxAccess';
import { GMAIL_REPLAY_FORMAT } from '@/lib/google/replay/format';
import { parseCheckpoint, serializeCheckpoint } from '@/lib/google/reader/mail';
import { buildGmailTwin, STALE_HISTORY_ID } from '../../scripts/google/build-gmail-twin';
import type { SeedMessage } from '../../scripts/google/lib/seedFormat';
import { createWorkerHandlers, runOnce } from '../../worker/classify';
import { createGuardedTenant, dropGuardedTenant, enableDiscoveryFlag, optInOwners, type GuardedTenant } from './support/guardedTenant';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !secret || !publishable) {
  throw new Error(
    'The exclusion policy test needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and ' +
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (local `supabase start` stack).',
  );
}
const db = createClient(url, secret, { auth: { persistSession: false } });
const hostname = new URL(url).hostname;
if (hostname !== '127.0.0.1' && hostname !== 'localhost') throw new Error('The exclusion policy test writes fixtures: local stack only.');

const RUN = Date.now().toString(36);
const DOMAIN = `xp-${RUN}.example`;
const GMAIL = `gina@${DOMAIN}`;
const GROUP = `conductia-ingest@${DOMAIN}`;
const env = { db, url, publishableKey: publishable, run: RUN, password: `Exclusion-${RUN}-x9!` };

const id = (name: string) => `<${name}-${RUN}@${DOMAIN}>`;
const message = (name: string, subject: string, body: string, over: Pick<SeedMessage, 'date'> & Partial<SeedMessage>): SeedMessage => ({
  messageId: id(name),
  from: { name: 'Gina Park', address: GMAIL },
  to: [{ name: 'Casey Buyer', address: `casey@osprey-capital.example` }],
  cc: [],
  subject,
  body: { contentType: 'text', content: body },
  mailboxes: [GMAIL],
  ...over,
});

// Distinct days, so the threads list in a fixed order.
const SEED: SeedMessage[] = [
  message('clean', 'Project Osprey: teaser draft', 'Project Osprey teaser attached for the buyer group.', { date: '2026-03-01T09:00:00Z' }),
  message('counsel', 'Project Osprey: counsel review', 'Project Osprey privileged advice COUNSELSECRET.', {
    date: '2026-03-02T09:00:00Z',
    to: [{ address: 'partner@counsel.example' }],
  }),
  message('marked', 'Project Osprey: board note', 'Project Osprey board only BOARDSECRET.', {
    date: '2026-03-03T09:00:00Z',
    headers: { Sensitivity: 'Company-Confidential' },
  }),
  message('valuation', 'Project Osprey: valuation', 'Project Osprey valuation range for the second buyer.', {
    date: '2026-03-04T09:00:00Z',
    to: [{ address: 'buyer2@osprey-capital.example' }],
  }),
  message('collision', 'Project Osprey: term sheet', 'Project Osprey term sheet, original text.', {
    date: '2026-03-05T09:00:00Z',
    to: [{ address: 'buyer3@osprey-capital.example' }],
  }),
];

const RULES_V1 = [
  { id: 'outside-counsel', category: 'privileged', scope: 'message', kind: 'participant_domain', domains: ['counsel.example'] },
  { id: 'confidential-marker', category: 'confidential', scope: 'message', kind: 'header_marker', header: 'sensitivity', contains: 'confidential' },
];
// Phase 2: two more messages, added to the mailbox's replay only when the label rule is in force.
const PHASE2_SEED: SeedMessage[] = [
  // Carries the user label Privileged in its metadata: excluded before any fetch.
  message('tagged', 'Project Osprey: advice', 'Project Osprey privileged TAGGEDSECRET.', {
    date: '2026-03-06T09:00:00Z',
    to: [{ address: 'buyer4@osprey-capital.example' }],
    labels: ['Privileged'],
  }),
  // Carries no label in its metadata; the raw answer will say Privileged (the label race, R10).
  message('racy', 'Project Osprey: late advice', 'Project Osprey privileged RACYSECRET.', {
    date: '2026-03-07T09:00:00Z',
    to: [{ address: 'buyer-race@osprey-capital.example' }],
  }),
];
const RULES_V2 = [
  ...RULES_V1,
  // Matches a message that was stored (routed) under the previous version, and one ledgered id_collision.
  { id: 'second-buyer', category: 'never_read', scope: 'message', kind: 'participant_address', addresses: ['buyer2@osprey-capital.example'] },
  { id: 'third-buyer', category: 'never_read', scope: 'message', kind: 'participant_address', addresses: ['buyer3@osprey-capital.example'] },
];
const LABEL_RULE = { id: 'privileged-label', category: 'privileged', scope: 'message', kind: 'label', names: ['privileged'] };
const INVALID = [{ id: 'bad', category: 'hr', scope: 'conversation', kind: 'participant_domain', domains: ['counsel.example'] }];
// Phase 3: two conversations. Thread A is read (a1) before it is tainted (a2 carries the label, later), and its
// last reply (a3) arrives later still; thread B is a lone labelled message (b1), then replies once its label is gone.
// Every message names the codename, so a message the policy did not exclude would be routed and stored.
const thread = (name: string, subject: string, body: string, over: Pick<SeedMessage, 'date'> & Partial<SeedMessage>): SeedMessage =>
  message(name, subject, body, { to: [{ address: 'casey@osprey-capital.example' }], ...over });
const A1 = thread('a1', 'Project Osprey: structure call', 'Project Osprey structure call, agenda A1TEXT.', { date: '2026-03-10T09:00:00Z' });
const A2 = thread('a2', 'Re: Project Osprey: structure call', 'Project Osprey privileged advice A2SECRET.', {
  date: '2026-03-11T09:00:00Z',
  inReplyTo: id('a1'),
  references: [id('a1')],
  labels: ['Privileged'],
  phase: 'after-imports',
});
// A reply with no label of its own that arrives in the last phase (it leaves SPAM there).
const A3 = thread('a3', 'Re: Project Osprey: structure call', 'Project Osprey quoting the advice A3SECRET.', {
  date: '2026-03-12T09:00:00Z',
  inReplyTo: id('a2'),
  references: [id('a1'), id('a2')],
  labels: ['SPAM'],
});
const B1_RECIPIENT = 'hr-note@osprey-capital.example';
const B1 = thread('b1', 'Project Osprey: staffing note', 'Project Osprey staffing note B1SECRET.', {
  date: '2026-03-13T09:00:00Z',
  to: [{ address: B1_RECIPIENT }],
  labels: ['Privileged'],
});
const B1_UNLABELLED: SeedMessage = { ...B1, labels: undefined };
const B2 = thread('b2', 'Re: Project Osprey: staffing note', 'Project Osprey staffing reply B2SECRET.', {
  date: '2026-03-14T09:00:00Z',
  inReplyTo: id('b1'),
  references: [id('b1')],
});
const B3 = thread('b3', 'Re: Project Osprey: staffing note', 'Project Osprey staffing follow-up B3TEXT.', {
  date: '2026-03-15T09:00:00Z',
  inReplyTo: id('b2'),
  references: [id('b1'), id('b2')],
});
const THREAD_SEED = [A1, A2, A3, B1, B2, B3];

let tenant: GuardedTenant;
let sourceId = '';
let restoreFlag: () => Promise<void> = async () => undefined;
let restoreWorkerFlag: () => Promise<void> = async () => undefined;
let previousMfa: string | undefined;
let previousReplayDir: string | undefined;
let previousReplayPhase: string | undefined;
let replayDir = '';
const collisionHeld = { hash: 'held-content-hash' };

async function setPolicy(rules: unknown[], expected: number): Promise<number> {
  const { data, error } = await db.rpc('discovery_exclusion_policy_set', {
    p_tenant_id: tenant.id,
    p_rules: rules,
    p_expected_version: expected,
    p_requested_by: 'Jordan Ames, CCO',
  });
  if (error) throw new Error(`policy write failed: ${error.message}`);
  return data as number;
}

const mirror = () => createFixtureAllowlistMirror(db);
const fixturePass = async () => {
  const summary = await runOnce({ tenantId: tenant.id, db, provider: READER_MODE.FIXTURE, mirror: mirror() });
  if (summary.status !== 'ok') throw new Error(`pass skipped: ${summary.reason}`);
  return summary;
};

type LedgerRow = Record<string, unknown> & { provider_item_id: string };
/** Ledger rows by seed name: the twin's Gmail ids are sha256(mailbox|messageId) truncated to 16 hex characters. */
async function ledgerRows(): Promise<Map<string, LedgerRow>> {
  const { createHash } = await import('node:crypto');
  const gmailId = (messageId: string) => createHash('sha256').update(`${GMAIL}|${messageId}`).digest('hex').slice(0, 16);
  const { data, error } = await db.from('routing_ledger').select('*').eq('source_id', sourceId);
  if (error) throw new Error(`ledger read failed: ${error.message}`);
  const rows = (data ?? []) as LedgerRow[];
  const byName = new Map<string, LedgerRow>();
  for (const seed of [...SEED, ...PHASE2_SEED, ...THREAD_SEED]) {
    const name = seed.messageId.slice(1, seed.messageId.indexOf('-'));
    const row = rows.find((r) => r.provider_item_id === gmailId(seed.messageId));
    if (row) byName.set(name, row);
  }
  return byName;
}

async function lastError(): Promise<string | null> {
  const { data } = await db.from('content_sources').select('last_error').eq('id', sourceId).single();
  return (data as { last_error: string | null }).last_error;
}

/** The delta cursor is gone (Gmail answers 404 to a history start it does not hold): the source resets, then backfills again. */
async function expireAndRebackfill(): Promise<void> {
  const { data: source } = await db.from('content_sources').select('delta_checkpoint').eq('id', sourceId).single();
  const checkpoint = parseCheckpoint((source as { delta_checkpoint: string }).delta_checkpoint);
  expect(checkpoint.phase).toBe('delta');
  await db
    .from('content_sources')
    // Two expired cursors in a row would halt the source (worker/sync.ts handleExpiry), so each starts a fresh streak.
    .update({ delta_checkpoint: serializeCheckpoint({ ...checkpoint, historyId: STALE_HISTORY_ID }), history_expiry_streak: 0 })
    .eq('id', sourceId);
  await fixturePass(); // the history start is gone: the cursor is reset
  await fixturePass(); // the re-backfill, under whatever policy is current
}

beforeAll(async () => {
  previousMfa = process.env.MFA_ENFORCEMENT;
  process.env.MFA_ENFORCEMENT = 'invite_only';
  restoreFlag = await enableDiscoveryFlag(db);
  // The queued sync handler also needs the worker's own switch on.
  const { data: worker } = await db.from('feature_flags').select('enabled').eq('key', 'discovery_worker_enabled').maybeSingle();
  const previousWorker = worker as { enabled: boolean } | null;
  const flagged = await db
    .from('feature_flags')
    .upsert({ key: 'discovery_worker_enabled', description: 'discovery worker (integration)', enabled: true }, { onConflict: 'key' });
  if (flagged.error) throw new Error(`worker flag upsert failed: ${flagged.error.message}`);
  restoreWorkerFlag = async () => {
    if (previousWorker) await db.from('feature_flags').update({ enabled: previousWorker.enabled }).eq('key', 'discovery_worker_enabled');
    else await db.from('feature_flags').delete().eq('key', 'discovery_worker_enabled');
  };

  // The real Gmail reader, in fixture mode, over a replay built from the seed (the twin builder, offline).
  replayDir = mkdtempSync(join(tmpdir(), 'exclusion-replay-'));
  for (const replay of buildGmailTwin(SEED)) {
    expect(replay.format).toBe(GMAIL_REPLAY_FORMAT);
    writeFileSync(join(replayDir, `${replay.mailbox}.replay.json`), JSON.stringify(replay));
  }
  previousReplayDir = process.env.DISCOVERY_GMAIL_REPLAY_DIR;
  process.env.DISCOVERY_GMAIL_REPLAY_DIR = replayDir;
  previousReplayPhase = process.env.DISCOVERY_GMAIL_REPLAY_PHASE;

  tenant = await createGuardedTenant(env, 'xp', [GMAIL]);
  const registration = await db.from('google_reader_registrations').insert({
    tenant_id: tenant.id,
    workspace_domain: DOMAIN,
    service_account_email: 'dwd-reader@proj-1.iam.gserviceaccount.com',
    client_id: '123456789012345678',
    directory_service_account_email: 'dir-reader@proj-1.iam.gserviceaccount.com',
    allowlist_group: GROUP,
    firm_company_id: tenant.companyId,
    status: 'active',
    consented_at: new Date().toISOString(),
  });
  if (registration.error) throw new Error(`google registration failed: ${registration.error.message}`);
  await optInOwners(tenant);
  const { data: source, error } = await db.from('content_sources').select('id').eq('tenant_id', tenant.id).single();
  if (error) throw new Error(`source lookup failed: ${error.message}`);
  sourceId = (source as { id: string }).id;
});

afterAll(async () => {
  if (previousMfa === undefined) delete process.env.MFA_ENFORCEMENT;
  else process.env.MFA_ENFORCEMENT = previousMfa;
  if (previousReplayDir === undefined) delete process.env.DISCOVERY_GMAIL_REPLAY_DIR;
  else process.env.DISCOVERY_GMAIL_REPLAY_DIR = previousReplayDir;
  if (previousReplayPhase === undefined) delete process.env.DISCOVERY_GMAIL_REPLAY_PHASE;
  else process.env.DISCOVERY_GMAIL_REPLAY_PHASE = previousReplayPhase;
  if (replayDir) rmSync(replayDir, { recursive: true, force: true });
  if (tenant) {
    await db.from('deal_candidates').delete().eq('tenant_id', tenant.id);
    await db.from('source_items').delete().eq('tenant_id', tenant.id);
    await db.from('content_sources').delete().eq('tenant_id', tenant.id);
    await db.from('google_reader_registrations').delete().eq('tenant_id', tenant.id);
    await dropGuardedTenant(env, tenant);
  }
  await restoreFlag();
  await restoreWorkerFlag();
});

describe('a live tenant without a usable exclusion policy is refused before any request (#263, R5)', () => {
  const liveRun = () => runOnce({ tenantId: tenant.id, db, provider: READER_MODE.LIVE, mirror: mirror() });
  const liveSync = () =>
    createWorkerHandlers({ db, boss: { send: async () => null }, provider: READER_MODE.LIVE, mirror: mirror() }).sync({
      tenantId: tenant.id,
      sourceId,
    });

  it('shows "No exclusion policy" as the source\'s Last error, in runOnce and in the queued sync handler', async () => {
    await expect(liveRun()).rejects.toMatchObject({ name: 'NoExclusionPolicyError' });
    expect(await lastError()).toBe('No exclusion policy');
    await db.from('content_sources').update({ last_error: null, last_error_at: null }).eq('id', sourceId);
    await expect(liveSync()).rejects.toMatchObject({ name: 'NoExclusionPolicyError' });
    expect(await lastError()).toBe('No exclusion policy');
  });

  it('shows "Exclusion policy invalid" in both paths when the current version fails validation, and reads nothing', async () => {
    expect(await setPolicy(INVALID, 0)).toBe(1);
    await db.from('content_sources').update({ last_error: null, last_error_at: null }).eq('id', sourceId);
    await expect(liveRun()).rejects.toMatchObject({ name: 'InvalidExclusionPolicyError' });
    expect(await lastError()).toBe('Exclusion policy invalid');
    await db.from('content_sources').update({ last_error: null, last_error_at: null }).eq('id', sourceId);
    await expect(liveSync()).rejects.toMatchObject({ name: 'InvalidExclusionPolicyError' });
    expect(await lastError()).toBe('Exclusion policy invalid');
    expect((await ledgerRows()).size).toBe(0);
    const { count } = await db.from('source_items').select('*', { count: 'exact', head: true }).eq('tenant_id', tenant.id);
    expect(count).toBe(0);
  });
});

describe('an excluded message is ledgered and never stored (acceptance 2, 3)', () => {
  let v1 = 0;

  it('writes a version through the audited RPC, and the audit row names the requester and the rule ids, not the domains', async () => {
    v1 = await setPolicy(RULES_V1, 1);
    expect(v1).toBe(2);
    const { data } = await db
      .from('audit_log')
      .select('detail, actor_type, service_identity, chain_seq')
      .eq('tenant_id', tenant.id)
      .eq('action', 'discovery.exclusion_policy_changed')
      .order('chain_seq');
    expect(data).toHaveLength(2);
    expect(data![1]).toMatchObject({
      actor_type: 'service',
      service_identity: 'exclusion-policy',
      detail: { version: 2, previousVersion: 1, ruleIds: ['outside-counsel', 'confidential-marker'], requestedBy: 'Jordan Ames, CCO' },
    });
    expect(JSON.stringify(data![1].detail)).not.toContain('counsel.example');
  });

  it('ledgers the counsel message and the marked message as policy skips, with rule, version, thread id and a metadata hash', async () => {
    // A held item that shares the collision message's Internet message id but not its content (a collision).
    const held = await db
      .from('source_items')
      .insert({
        tenant_id: tenant.id,
        kind: 'message',
        subject: 'Project Osprey: term sheet',
        participants: [],
        internet_message_id: id('collision'),
        content_hash: collisionHeld.hash,
      })
      .select('id')
      .single();
    if (held.error) throw new Error(`held item failed: ${held.error.message}`);
    await db.from('source_item_texts').insert({ source_item_id: held.data.id, body_text: 'A wholly different held text about another matter.' });

    await fixturePass();
    expect(await lastError()).toBeNull();
    const rows = await ledgerRows();

    for (const [name, rule] of [
      ['counsel', 'outside-counsel'],
      ['marked', 'confidential-marker'],
    ] as const) {
      expect(rows.get(name), name).toMatchObject({
        decision: 'skipped',
        skip_reason: 'policy_excluded',
        exclusion_rule: rule,
        policy_version: v1,
        // Metadata only: no identifiers of the message's own, and a hash of provider metadata.
        conversation_id: null,
        internet_message_id: null,
      });
      expect(rows.get(name)!.provider_thread_id).toEqual(expect.stringMatching(/^[0-9a-f]{16}$/));
      expect(rows.get(name)!.item_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(rows.get('clean')).toMatchObject({ decision: 'routed', skip_reason: null, policy_version: null });
    expect(rows.get('valuation')).toMatchObject({ decision: 'routed' });
    expect(rows.get('collision')).toMatchObject({ decision: 'skipped', skip_reason: 'id_collision' });
  });

  it('records the pass with what crossed the wire, what the policy kept out, and what was stored, and the ledger agrees (#370, #344 G2)', async () => {
    const { data, error } = await db
      .from('audit_log')
      .select('detail')
      .eq('tenant_id', tenant.id)
      .eq('action', 'discovery.reader_pass_finished')
      .order('chain_seq', { ascending: false })
      .limit(1)
      .single();
    if (error) throw new Error(`pass read failed: ${error.message}`);
    const end = (data as { detail: Record<string, unknown> }).detail;
    // clean, valuation and collision were fetched raw; counsel and marked were excluded on metadata; clean and
    // valuation were stored (collision is ledgered id_collision). The replay authenticates with no registration.
    expect(end).toMatchObject({ sourceId, provider: 'google', status: 'complete', fetched: 3, excluded: 2, stored: 2, registration: null });

    const { data: ledger } = await db.from('routing_ledger').select('decision, skip_reason').eq('source_id', sourceId).eq('run_id', end.runId as string);
    const rows = (ledger ?? []) as Array<{ decision: string; skip_reason: string | null }>;
    const neverFetched = new Set(['policy_excluded', 'policy_thread_excluded', 'policy_unevaluable']);
    expect(rows.filter((row) => row.skip_reason !== null && neverFetched.has(row.skip_reason))).toHaveLength(end.excluded as number);
    expect(rows.filter((row) => row.skip_reason === null || !neverFetched.has(row.skip_reason))).toHaveLength(end.fetched as number);
    expect(rows.filter((row) => row.decision === 'routed')).toHaveLength(end.stored as number);
  });

  it('stores no item and no text for an excluded message: nothing of it exists outside its ledger row', async () => {
    const { data: items } = await db
      .from('source_items')
      .select('id, internet_message_id, subject')
      .eq('tenant_id', tenant.id);
    const ids = new Set((items ?? []).map((i) => i.internet_message_id as string));
    expect(ids.has(id('counsel'))).toBe(false);
    expect(ids.has(id('marked'))).toBe(false);
    expect(ids.has(id('clean'))).toBe(true);
    const subjects = (items ?? []).map((i) => String(i.subject));
    expect(subjects.join(' ')).not.toMatch(/counsel review|board note/);

    const { data: texts } = await db
      .from('source_item_texts')
      .select('body_text')
      .in('source_item_id', (items ?? []).map((i) => i.id as string));
    const all = (texts ?? []).map((t) => String(t.body_text)).join('\n');
    expect(all).not.toContain('COUNSELSECRET');
    expect(all).not.toContain('BOARDSECRET');
    expect(all).toContain('teaser attached');
  });
});

describe('a later version applies to later passes, and a policy skip never replaces an earlier read (G1)', () => {
  it('re-backfills after an expired cursor under version 3: refreshed skips, and the read rows untouched', async () => {
    const before = await ledgerRows();
    const readBefore = {
      valuation: before.get('valuation')!,
      collision: before.get('collision')!,
    };
    expect(readBefore.valuation.decision).toBe('routed');
    expect(readBefore.collision.skip_reason).toBe('id_collision');
    expect(readBefore.collision.collision_similarity).not.toBeNull();

    const v3 = await setPolicy(RULES_V2, 2);
    expect(v3).toBe(3);

    // Expire the incremental cursor: the twin answers 404 to a history start it does not hold.
    const { data: source } = await db.from('content_sources').select('delta_checkpoint, backfill_completed_at').eq('id', sourceId).single();
    const checkpoint = parseCheckpoint((source as { delta_checkpoint: string }).delta_checkpoint);
    expect(checkpoint.phase).toBe('delta');
    await db
      .from('content_sources')
      .update({ delta_checkpoint: serializeCheckpoint({ ...checkpoint, historyId: STALE_HISTORY_ID }) })
      .eq('id', sourceId);

    const expired = await fixturePass();
    expect(expired.itemsRead).toBe(0);
    const { data: reset } = await db.from('content_sources').select('delta_checkpoint, backfill_completed_at').eq('id', sourceId).single();
    expect(reset).toEqual({ delta_checkpoint: null, backfill_completed_at: null });

    // The re-backfill, under version 3: the new rules now match two messages that were read before.
    await fixturePass();
    const rows = await ledgerRows();

    // Later passes use the new version: the earlier policy skips are refreshed.
    for (const name of ['counsel', 'marked']) {
      expect(rows.get(name), name).toMatchObject({ skip_reason: 'policy_excluded', policy_version: 3 });
    }
    // The stored message stays routed, with its method and content hash (its text is still held).
    expect(rows.get('valuation')).toMatchObject({
      decision: 'routed',
      skip_reason: null,
      method: readBefore.valuation.method,
      item_hash: readBefore.valuation.item_hash,
      policy_version: null,
      exclusion_rule: null,
    });
    expect(rows.get('valuation')!.method).not.toBeNull();
    // The collision keeps its reason and its distances: a never-fetched skip never hides what was read.
    expect(rows.get('collision')).toMatchObject({
      skip_reason: 'id_collision',
      collision_similarity: readBefore.collision.collision_similarity,
      collision_length_ratio: readBefore.collision.collision_length_ratio,
      item_hash: readBefore.collision.item_hash,
      policy_version: null,
    });
    // And its stored text is still there.
    const { data: valuation } = await db.from('source_items').select('id').eq('tenant_id', tenant.id).eq('internet_message_id', id('valuation')).single();
    const { data: text } = await db.from('source_item_texts').select('body_text').eq('source_item_id', (valuation as { id: string }).id).single();
    expect((text as { body_text: string }).body_text).toContain('valuation range');
  });

  it('chains every policy change in the tenant audit log', async () => {
    const { data } = await db
      .from('audit_log')
      .select('detail, chain_seq')
      .eq('tenant_id', tenant.id)
      .eq('action', 'discovery.exclusion_policy_changed')
      .order('chain_seq');
    expect((data ?? []).map((row) => row.detail.version)).toEqual([1, 2, 3]);
    const seqs = (data ?? []).map((row) => row.chain_seq as number);
    expect(seqs.every((seq) => Number.isInteger(seq))).toBe(true);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });
});

describe('a label rule: before the fetch, and after it when a label arrived in between (phase 2, R10)', () => {
  const gmailIdOf = async (name: string) => {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(`${GMAIL}|${id(name)}`).digest('hex').slice(0, 16);
  };

  /**
   * The replay of the mailbox with the phase 2 messages. The raw answers of the racy message, and of the clean one
   * that was stored under every earlier version, carry the Privileged label their metadata lacks.
   */
  async function writeRacyReplay(): Promise<void> {
    const raced = [await gmailIdOf('racy'), await gmailIdOf('clean')];
    for (const replay of buildGmailTwin([...SEED, ...PHASE2_SEED])) {
      for (const [key, answers] of Object.entries(replay.phases.seeded)) {
        if (!raced.some((rawId) => key.includes(`/messages/${rawId}?format=raw`))) continue;
        for (const answer of answers) {
          const body = answer.body as { labelIds?: string[] };
          if (body.labelIds) body.labelIds = [...body.labelIds, 'Label_1'];
        }
      }
      writeFileSync(join(replayDir, `${replay.mailbox}.replay.json`), JSON.stringify(replay));
    }
  }

  it('skips the labelled message before any fetch, and ledgers the raced one as policy_excluded_after_fetch with nothing stored', async () => {
    await writeRacyReplay();
    const v4 = await setPolicy([...RULES_V2, LABEL_RULE], 3);
    expect(v4).toBe(4);
    await expireAndRebackfill();
    expect(await lastError()).toBeNull();
    const rows = await ledgerRows();

    expect(rows.get('tagged')).toMatchObject({
      decision: 'skipped',
      skip_reason: 'policy_excluded',
      exclusion_rule: 'privileged-label',
      policy_version: 4,
      conversation_id: null,
      internet_message_id: null,
    });
    expect(rows.get('racy')).toMatchObject({
      decision: 'skipped',
      skip_reason: 'policy_excluded_after_fetch',
      exclusion_rule: 'privileged-label',
      policy_version: 4,
      conversation_id: null,
      internet_message_id: null,
    });
    for (const name of ['tagged', 'racy']) {
      expect(rows.get(name)!.provider_thread_id, name).toEqual(expect.stringMatching(/^[0-9a-f]{16}$/));
      expect(rows.get(name)!.item_hash, name).toMatch(/^[0-9a-f]{64}$/);
    }

    // Neither exists outside its ledger row: no item, and none of its text. The raced body was fetched and dropped unparsed.
    const { data: items } = await db.from('source_items').select('id, internet_message_id, subject').eq('tenant_id', tenant.id);
    const stored = new Set((items ?? []).map((i) => i.internet_message_id as string));
    expect(stored.has(id('tagged'))).toBe(false);
    expect(stored.has(id('racy'))).toBe(false);
    const { data: texts } = await db
      .from('source_item_texts')
      .select('body_text')
      .in('source_item_id', (items ?? []).map((i) => i.id as string));
    const all = (texts ?? []).map((t) => String(t.body_text)).join('\n');
    expect(all).not.toContain('TAGGEDSECRET');
    expect(all).not.toContain('RACYSECRET');
  });

  it('never replaces a stored message\'s routed row with an after-fetch skip: it was read before, and its text is still held', async () => {
    // The clean message was routed and stored under versions 1 to 3. Now its raw answer says Privileged too.
    const rows = await ledgerRows();
    expect(rows.get('clean')).toMatchObject({ decision: 'routed', skip_reason: null, policy_version: null, exclusion_rule: null });
    expect(rows.get('clean')!.method).not.toBeNull();
    const { data: held } = await db.from('source_items').select('id').eq('tenant_id', tenant.id).eq('internet_message_id', id('clean')).single();
    const { data: text } = await db.from('source_item_texts').select('body_text').eq('source_item_id', (held as { id: string }).id).single();
    expect((text as { body_text: string }).body_text).toContain('teaser attached');
  });

  it('leaves the after-fetch row unchanged when a rule now excludes that message at metadata time, and refreshes the never-fetched one', async () => {
    const read = await ledgerRows();
    const before = read.get('racy')!;
    expect(before.skip_reason).toBe('policy_excluded_after_fetch');
    const cleanBefore = read.get('clean')!;

    // v5 adds a rule that matches the raced message on its recipient: at metadata time it is now excluded outright.
    const v5 = await setPolicy(
      [
        ...RULES_V2,
        LABEL_RULE,
        { id: 'race-recipient', category: 'never_read', scope: 'message', kind: 'participant_address', addresses: ['buyer-race@osprey-capital.example'] },
      ],
      4,
    );
    expect(v5).toBe(5);
    await expireAndRebackfill();
    const after = await ledgerRows();

    // A policy skip that never fetched never replaces a row that records a fetch (R2).
    expect(after.get('racy')).toMatchObject({
      skip_reason: 'policy_excluded_after_fetch',
      exclusion_rule: before.exclusion_rule,
      policy_version: 4,
      item_hash: before.item_hash,
      provider_thread_id: before.provider_thread_id,
    });
    expect(after.get('clean')).toMatchObject({ decision: 'routed', method: cleanBefore.method, item_hash: cleanBefore.item_hash });
    // The message that was never fetched is refreshed to the current version.
    expect(after.get('tagged')).toMatchObject({ skip_reason: 'policy_excluded', policy_version: 5 });
  });
});

// Thread scope across passes (phase 3, Q1). One mailbox, one story: the replay's phases stand for the mailbox over time
// (`seeded`, `after-imports`, `after-unspam`), and a new replay file stands for an edit made in Gmail (a label removed,
// a reply delivered). The policy at the start is version 5; each step writes the next version.
describe('a thread rule holds across passes (phase 3, Q1)', () => {
  const BASE = [...SEED, ...PHASE2_SEED];
  const gmailIdOf = async (name: string) => {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(`${GMAIL}|${id(name)}`).digest('hex').slice(0, 16);
  };
  const writeReplay = (messages: SeedMessage[]) => {
    for (const replay of buildGmailTwin([...BASE, ...messages])) {
      writeFileSync(join(replayDir, `${replay.mailbox}.replay.json`), JSON.stringify(replay));
    }
  };
  const setPhase = (phase: string) => {
    process.env.DISCOVERY_GMAIL_REPLAY_PHASE = phase;
  };
  const sourceItemSubjects = async () => {
    const { data } = await db.from('source_items').select('id, internet_message_id').eq('tenant_id', tenant.id);
    return new Map(((data ?? []) as Array<{ id: string; internet_message_id: string }>).map((i) => [i.internet_message_id, i.id]));
  };
  const storedText = async (name: string): Promise<string | null> => {
    const item = (await sourceItemSubjects()).get(id(name));
    if (!item) return null;
    const { data } = await db.from('source_item_texts').select('body_text').eq('source_item_id', item).maybeSingle();
    return (data as { body_text: string } | null)?.body_text ?? null;
  };
  const allText = async (): Promise<string> => {
    const { data: items } = await db.from('source_items').select('id').eq('tenant_id', tenant.id);
    const { data: texts } = await db
      .from('source_item_texts')
      .select('body_text')
      .in('source_item_id', (items ?? []).map((i) => i.id as string));
    return (texts ?? []).map((t) => String(t.body_text)).join('\n');
  };
  type TaintRow = { provider_thread_id: string; rule_id: string; policy_version: number; provider_item_id: string };
  const taints = async (): Promise<TaintRow[]> => {
    const { data, error } = await db
      .from('discovery_thread_taints')
      .select('provider_thread_id, rule_id, policy_version, provider_item_id')
      .eq('source_id', sourceId);
    if (error) throw new Error(`taint read failed: ${error.message}`);
    return (data ?? []) as TaintRow[];
  };
  /** Every ledger row of one conversation of this mailbox: the join that shows a tainted thread's earlier reads. */
  const threadRows = async (threadId: string) => {
    const { data } = await db
      .from('routing_ledger')
      .select('provider_item_id, decision, skip_reason, method, item_hash, exclusion_rule, policy_version')
      .eq('source_id', sourceId)
      .eq('provider_thread_id', threadId);
    return (data ?? []) as Array<Record<string, unknown> & { provider_item_id: string }>;
  };

  const THREAD_RULE = { ...LABEL_RULE, scope: 'thread' };
  // Version 5's rules, with the label rule widened from message to thread scope (its id and condition are unchanged).
  const RULES_V6 = [
    ...RULES_V2,
    THREAD_RULE,
    { id: 'race-recipient', category: 'never_read', scope: 'message', kind: 'participant_address', addresses: ['buyer-race@osprey-capital.example'] },
  ];
  let threadA = '';
  let threadB = '';
  let a1Before: LedgerRow;

  it('reads the earlier message of a conversation before it is tainted, with its thread id on the routed row', async () => {
    const v6 = await setPolicy(RULES_V6, 5);
    expect(v6).toBe(6);
    writeReplay([A1, A2, A3, B1]);
    setPhase('seeded');
    await expireAndRebackfill();
    expect(await lastError()).toBeNull();

    const rows = await ledgerRows();
    // a1 was read and stored; a2 has not arrived yet, and a3 is still in SPAM (silently dropped, as ever).
    expect(rows.get('a1')).toMatchObject({ decision: 'routed', skip_reason: null, policy_version: null });
    expect(rows.get('a1')!.provider_thread_id).toEqual(expect.stringMatching(/^[0-9a-f]{16}$/));
    expect(rows.has('a2')).toBe(false);
    expect(rows.has('a3')).toBe(false);
    expect(await storedText('a1')).toContain('A1TEXT');
    threadA = rows.get('a1')!.provider_thread_id as string;
    a1Before = rows.get('a1')!;

    // b1 carries the label: its own match is the ledger's reason, and it taints its conversation.
    expect(rows.get('b1')).toMatchObject({ decision: 'skipped', skip_reason: 'policy_excluded', exclusion_rule: 'privileged-label', policy_version: 6 });
    threadB = rows.get('b1')!.provider_thread_id as string;
    expect(await taints()).toEqual(
      expect.arrayContaining([
        { provider_thread_id: threadB, rule_id: 'privileged-label', policy_version: 6, provider_item_id: await gmailIdOf('b1') },
      ]),
    );
  });

  it('pass 2: a labelled reply arrives and is excluded as the trigger; the message stored before it stays stored, and one join finds both', async () => {
    setPhase('after-imports');
    const pass = await fixturePass();
    expect(pass.itemsRead).toBeGreaterThan(0);
    const rows = await ledgerRows();
    expect(rows.get('a2')).toMatchObject({
      decision: 'skipped',
      skip_reason: 'policy_excluded',
      exclusion_rule: 'privileged-label',
      policy_version: 6,
      provider_thread_id: threadA,
    });
    // Forward only: a1 was not itself privileged when it was read, so it stays routed and its text stays held.
    expect(rows.get('a1')).toMatchObject({ decision: 'routed', method: a1Before.method, item_hash: a1Before.item_hash });
    expect(await storedText('a1')).toContain('A1TEXT');
    expect(await storedText('a2')).toBeNull();
    expect(await allText()).not.toContain('A2SECRET');

    // The join on (source_id, provider_thread_id): the stored earlier read, and the trigger.
    const joined = await threadRows(threadA);
    expect(joined.map((r) => [r.provider_item_id, r.decision, r.skip_reason]).sort()).toEqual(
      [
        [await gmailIdOf('a1'), 'routed', null],
        [await gmailIdOf('a2'), 'skipped', 'policy_excluded'],
      ].sort(),
    );
    expect(await taints()).toEqual(
      expect.arrayContaining([
        { provider_thread_id: threadA, rule_id: 'privileged-label', policy_version: 6, provider_item_id: await gmailIdOf('a2') },
      ]),
    );
  });

  it('pass 3: an unlabelled reply that arrives later is excluded as inherited, never stored, with the version and rule', async () => {
    setPhase('after-unspam');
    await fixturePass();
    const rows = await ledgerRows();
    expect(rows.get('a3')).toMatchObject({
      decision: 'skipped',
      skip_reason: 'policy_thread_excluded',
      exclusion_rule: 'privileged-label',
      policy_version: 6,
      provider_thread_id: threadA,
      conversation_id: null,
      internet_message_id: null,
    });
    expect(rows.get('a3')!.item_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await storedText('a3')).toBeNull();
    expect(await allText()).not.toContain('A3SECRET');
    expect(await lastError()).toBeNull();
  });

  it('an expired cursor\'s re-backfill under the thread rule leaves the stored message routed, and the trigger a policy skip (G1)', async () => {
    await expireAndRebackfill();
    const rows = await ledgerRows();
    // a1 is evaluated again and inherits the taint, but its row records a read: it is not replaced.
    expect(rows.get('a1')).toMatchObject({
      decision: 'routed',
      skip_reason: null,
      method: a1Before.method,
      item_hash: a1Before.item_hash,
      policy_version: null,
      exclusion_rule: null,
      provider_thread_id: threadA,
    });
    expect(rows.get('a1')!.method).not.toBeNull();
    expect(await storedText('a1')).toContain('A1TEXT');
    expect(rows.get('a2')).toMatchObject({ skip_reason: 'policy_excluded', exclusion_rule: 'privileged-label', policy_version: 6 });
    expect(rows.get('a3')).toMatchObject({ skip_reason: 'policy_thread_excluded', policy_version: 6 });
    // The join still returns the stored earlier read next to the trigger and the inherited reply.
    const joined = await threadRows(threadA);
    expect(joined.map((r) => r.skip_reason ?? r.decision).sort()).toEqual(['policy_excluded', 'policy_thread_excluded', 'routed']);
  });

  it('a reordered policy and a re-backfill refresh the ledger reason but cannot erase the taint, so a later reply is still excluded (R3)', async () => {
    // v7 lists a message rule that matches b1's recipient before the thread rule.
    const v7 = await setPolicy(
      [{ id: 'b1-recipient', category: 'never_read', scope: 'message', kind: 'participant_address', addresses: [B1_RECIPIENT] }, ...RULES_V6],
      6,
    );
    expect(v7).toBe(7);
    await expireAndRebackfill();
    let rows = await ledgerRows();
    // The never-fetched row's reason is refreshed to the first match in the new order...
    expect(rows.get('b1')).toMatchObject({ skip_reason: 'policy_excluded', exclusion_rule: 'b1-recipient', policy_version: 7 });
    // ...and the taint kept the version-6 provenance, which no refresh touches.
    const held = (await taints()).find((t) => t.provider_thread_id === threadB && t.rule_id === 'privileged-label');
    expect(held).toMatchObject({ policy_version: 6, provider_item_id: await gmailIdOf('b1') });

    // The label is removed in Gmail, and a new reply arrives: nothing in the mailbox shows the conversation as privileged.
    writeReplay([A1, A2, A3, B1_UNLABELLED, B2]);
    await expireAndRebackfill();
    rows = await ledgerRows();
    expect(rows.get('b1')).toMatchObject({ skip_reason: 'policy_excluded', exclusion_rule: 'b1-recipient' });
    expect(rows.get('b2')).toMatchObject({
      decision: 'skipped',
      skip_reason: 'policy_thread_excluded',
      exclusion_rule: 'privileged-label',
      policy_version: 7,
      provider_thread_id: threadB,
    });
    expect(await storedText('b2')).toBeNull();
    expect(await allText()).not.toContain('B2SECRET');
    expect(await allText()).not.toContain('B1SECRET');
  });

  it('narrowing the label rule to message scope stops the old taint: a later reply is read, and the held conversation is read again', async () => {
    const v8 = await setPolicy(
      [
        { id: 'b1-recipient', category: 'never_read', scope: 'message', kind: 'participant_address', addresses: [B1_RECIPIENT] },
        ...RULES_V6.map((rule) => (rule.id === 'privileged-label' ? { ...rule, scope: 'message' } : rule)),
      ],
      7,
    );
    expect(v8).toBe(8);
    writeReplay([A1, A2, A3, B1_UNLABELLED, B2, B3]);
    await expireAndRebackfill();
    expect(await lastError()).toBeNull();
    const rows = await ledgerRows();

    // The stored taint no longer applies (the rule is message-scoped now), so the new reply is an ordinary message.
    expect(rows.get('b3')).toMatchObject({ decision: 'routed', skip_reason: null, policy_version: null });
    expect(await storedText('b3')).toContain('B3TEXT');
    // b2 was held back by that taint and never fetched: it is read now. The message rule still excludes b1 and a2.
    expect(rows.get('b2')).toMatchObject({ decision: 'routed', skip_reason: null });
    expect(await storedText('b2')).toContain('B2SECRET');
    expect(rows.get('b1')).toMatchObject({ skip_reason: 'policy_excluded', exclusion_rule: 'b1-recipient', policy_version: 8 });
    expect(rows.get('a2')).toMatchObject({ skip_reason: 'policy_excluded', exclusion_rule: 'privileged-label', policy_version: 8 });
    expect(rows.get('a3')).toMatchObject({ decision: 'routed' });
    // The taints stay in the table (insert-only): they simply stop being applied.
    expect((await taints()).some((t) => t.provider_thread_id === threadB && t.rule_id === 'privileged-label')).toBe(true);
  });
});

describe('the firm admin sees the result in ingestion health (#263, phase 4)', () => {
  it('counts every policy skip under every version, and reports the current version as its own fact', async () => {
    const admin = tenant.sessions[tenant.mailboxes.length];
    const { data, error } = await admin.rpc('discovery_ingestion_health');
    expect(error).toBeNull();
    const health = data as {
      policyVersion: number | null;
      sources: Array<{ id: string; itemsSkipped: number; itemsExcluded: number; itemsLedgered: number }>;
      totals: { itemsSkipped: number; itemsExcluded: number; itemsLedgered: number };
    };

    // What the ledger and the policy table hold, read as the service role.
    const { data: ledger } = await db.from('routing_ledger').select('skip_reason, policy_version').eq('source_id', sourceId);
    const rows = (ledger ?? []) as Array<{ skip_reason: string | null; policy_version: number | null }>;
    const excluded = rows.filter((r) => r.skip_reason?.startsWith('policy_'));
    const { data: versions } = await db
      .from('discovery_exclusion_policies')
      .select('version')
      .eq('tenant_id', tenant.id)
      .order('version', { ascending: false })
      .limit(1);
    const current = (versions as Array<{ version: number }>)[0].version;

    // The story left policy skips under more than one version, so "all versions" is a real claim here.
    expect(new Set(excluded.map((r) => r.policy_version)).size).toBeGreaterThan(1);
    expect(health.totals.itemsExcluded).toBe(excluded.length);
    expect(health.sources.find((s) => s.id === sourceId)?.itemsExcluded).toBe(excluded.length);
    // The exclusions are among the skipped rows, never extra to them.
    expect(health.totals.itemsSkipped).toBe(rows.filter((r) => r.skip_reason !== null).length);
    expect(health.totals.itemsExcluded).toBeLessThanOrEqual(health.totals.itemsSkipped);
    expect(health.totals.itemsLedgered).toBe(rows.length);
    // The version is the current one, not a count and not the version the exclusions were written under.
    expect(health.policyVersion).toBe(current);
    expect(health.policyVersion).not.toBe(excluded.length);

    // Counts and a version only: no rule id, thread id, subject or address of an excluded message.
    const text = JSON.stringify(health);
    for (const leaked of ['privileged-label', 'outside-counsel', 'counsel.example', 'COUNSELSECRET', 'providerThreadId', 'Osprey', 'hr-note@']) {
      expect(text).not.toContain(leaked);
    }
  });
});
