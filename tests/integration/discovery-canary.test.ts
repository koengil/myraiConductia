import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { createGmailMailContentSource } from '@/lib/google/reader/mail';
import { NO_EXCLUSION } from '../google/exclusion';
import { GoogleHttpError } from '@/lib/google/reader/http';
import { replayFetch } from '@/lib/google/reader/replay';
import type { GmailReplay } from '@/lib/google/replay/format';
import { MAILBOX_PROVIDER, READER_MODE, SOURCE_KIND } from '@/lib/constants/discovery';
import { readIngestionHealth } from '@/lib/discovery/api';
import { messageKey } from '@/lib/discovery/propose/key';
import { PROPOSE_FLAG } from '@/lib/discovery/propose/step';
import { createFixtureContentSource } from '@/lib/graph/reader/fixture';

import { buildGmailTwin, twinFileName } from '../../scripts/google/build-gmail-twin';
import { fixtureToSeed } from '../../scripts/google/fixture-to-seed';
import type { SeedMessage } from '../../scripts/google/lib/seedFormat';
import { runOnce, summaryLine, type RunSummary } from '../../worker/classify';
import { proposeReplyDouble } from '../helpers/proposeReplyDouble';
import { seatOnDeal } from './support/guardedTenant';
import { dumpData } from './support/pgDump';

/*
 * The canary (#259 R23, the database and log half). A message that is not a
 * deal message carries a marker string. Discovery may read it, but nothing may
 * keep it: an unrouted message is dropped after routing, so the marker must be
 * in no table, in nothing the worker prints, and in no error a failed read
 * throws. It runs one pass over BOTH providers: Graph's fixture (with a canary
 * message in Alice's mailbox) and the Gmail twin (with a canary message in the
 * colleague's mailbox), so neither reader can be the one that leaks.
 *
 * The marker is checked three ways:
 *   1. every table, through pg_dump --data-only (needs DATABASE_URL);
 *   2. everything written to console, stdout and stderr during the pass;
 *   3. the message and serialization of the GoogleHttpError a replay's 500
 *      on the canary's messages.get produces.
 * A control check proves the dump and the capture are not blind: the routed
 * Falcon evidence is found by both.
 *
 * The last describe completes R23 for the admin's side: a real failed read
 * (Google answers 500 on the canary, and the body quotes it) leaves one
 * content-free line in content_sources.last_error, and the firm admin's health
 * payload carries that line, the provider and the state of each source, and not
 * the canary, a subject, a body or a Message-ID.
 */

const CANARY = 'CANARY-7f3e9a1c';
const CANARY_CONTENT = ['Parking notice', 'Kitchen rota', 'parking is closed', 'kitchen rota moves'];
const CANARY_MESSAGE_IDS = ['canary-gmail@', 'canary-graph@'];

// The Graph fixture reader reads a directory chosen at call time, so the pass can
// read a corpus with the canary in it. Only the directory is replaced: the
// capability check and the reader itself are the real ones.
const graphDir = vi.hoisted(() => ({ value: '' }));
vi.mock('@/lib/graph/reader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/graph/reader')>();
  const capabilityModule = await import('@/lib/discovery/source/capability');
  const demandCapability: (candidate: unknown) => void = capabilityModule.requireReaderCapability;
  return {
    ...actual,
    getContentSource: (capability: unknown) => {
      demandCapability(capability);
      return createFixtureContentSource(capability as never, { dir: graphDir.value });
    },
  };
});

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !secret || !publishable) {
  throw new Error(
    'The canary needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (local `supabase start` stack).',
  );
}
const db = createClient(url, secret, { auth: { persistSession: false } });

const RUN = Date.now().toString(36);
const TENANT = crypto.randomUUID();
const PASSWORD = `Canary-${RUN}-x9!`;

type Persona = 'alice' | 'colleague' | 'bob';
const users: Record<Persona, { id: string; email: string }> = {
  alice: { id: '', email: `cy-alice-${RUN}@integration.conductia.dev` },
  colleague: { id: '', email: `cy-colleague-${RUN}@integration.conductia.dev` },
  bob: { id: '', email: `cy-bob-${RUN}@integration.conductia.dev` },
};
// Graph reads Alice's and Bob's mailboxes, Gmail reads the colleague's: one address, one provider.
const MAILBOXES: Array<{ address: string; owner: Persona; provider: 'microsoft' | 'google' }> = [
  { address: 'storm.duncan@bank.example', owner: 'alice', provider: 'microsoft' },
  { address: 'alex.chen@bank.example', owner: 'bob', provider: 'microsoft' },
  { address: 'morgan.vale@bank.example', owner: 'colleague', provider: 'google' },
];

const sessions = new Map<string, SupabaseClient>();
let bankCompanyId = '';
let previousFlag: { enabled: boolean } | null = null;
let previousMfa: string | undefined;
const scratch = mkdtempSync(join(tmpdir(), 'discovery-canary-'));
const gmailDir = join(scratch, 'gmail');
const fixtureDir = join(scratch, 'graph');

const canaryGmail: SeedMessage = {
  messageId: '<canary-gmail@bank.example>',
  date: '2026-02-24T10:00:00Z',
  from: { name: 'Morgan Vale', address: 'morgan.vale@bank.example' },
  to: [{ name: 'Alex Chen', address: 'alex.chen@bank.example' }],
  cc: [],
  subject: `Parking notice ${CANARY}`,
  body: { contentType: 'text', content: `Level 3 parking is closed on Friday. Reference ${CANARY}.` },
  mailboxes: ['morgan.vale@bank.example'],
  phase: 'seeded',
};

async function setFlag(enabled: boolean): Promise<void> {
  const { error } = await db
    .from('feature_flags')
    .upsert({ key: 'deal_discovery', description: 'deal discovery (integration)', enabled }, { onConflict: 'key' });
  if (error) throw new Error(`flag upsert failed: ${error.message}`);
}

beforeAll(async () => {
  previousMfa = process.env.MFA_ENFORCEMENT;
  process.env.MFA_ENFORCEMENT = 'invite_only';

  // The corpora: the Graph fixture and the Gmail twin, each with a canary message.
  mkdirSync(fixtureDir, { recursive: true });
  const source = join(process.cwd(), 'tests', 'fixtures', 'discovery');
  for (const name of readdirSync(source).filter((f) => f.endsWith('.json'))) copyFileSync(join(source, name), join(fixtureDir, name));
  const stormFile = join(fixtureDir, 'mailbox-storm.json');
  const storm = JSON.parse(readFileSync(stormFile, 'utf8')) as { messages: Array<Record<string, unknown>> };
  storm.messages.push({
    id: 'AAMk-storm-canary',
    internetMessageId: '<canary-graph@bank.example>',
    conversationId: 'conv-canary',
    subject: `Kitchen rota ${CANARY}`,
    sentDateTime: '2026-02-24T09:00:00Z',
    from: { emailAddress: { name: 'Storm Duncan', address: 'storm.duncan@bank.example' } },
    toRecipients: [{ emailAddress: { name: 'Alex Chen', address: 'alex.chen@bank.example' } }],
    ccRecipients: [],
    body: { contentType: 'text', content: `The kitchen rota moves to Tuesday. Reference ${CANARY}.` },
  });
  writeFileSync(stormFile, JSON.stringify(storm));
  graphDir.value = fixtureDir;
  mkdirSync(gmailDir, { recursive: true });
  for (const replay of buildGmailTwin([...fixtureToSeed(), canaryGmail])) {
    writeFileSync(join(gmailDir, twinFileName(replay.mailbox)), JSON.stringify(replay));
  }
  process.env.DISCOVERY_GMAIL_REPLAY_DIR = gmailDir;

  const { data: flagRow } = await db.from('feature_flags').select('enabled').eq('key', 'deal_discovery').maybeSingle();
  previousFlag = flagRow as { enabled: boolean } | null;
  await setFlag(true);

  for (const persona of Object.keys(users) as Persona[]) {
    const user = users[persona];
    const { data, error } = await db.auth.admin.createUser({
      email: user.email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { tenant_id: TENANT, department: 'ib' },
    });
    if (error || !data.user) throw new Error(`auth user create failed: ${error?.message}`);
    user.id = data.user.id;
    const { error: updateError } = await db
      .from('users')
      .update({ tenant_id: TENANT, status: 'active', firm_role: null, is_external: false })
      .eq('id', user.id);
    if (updateError) throw new Error(`user claim failed: ${updateError.message}`);
    const client = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: signInError } = await client.auth.signInWithPassword({ email: user.email, password: PASSWORD });
    if (signInError) throw new Error(`sign-in failed for ${persona}: ${signInError.message}`);
    sessions.set(persona, client);
  }

  const company = await db
    .from('companies')
    .insert({ tenant_id: TENANT, name: `Canary Bank ${RUN}`, type: 'bank' })
    .select('id')
    .single();
  if (company.error) throw new Error(`bank company failed: ${company.error.message}`);
  bankCompanyId = company.data.id as string;
  const seat = async (persona: Persona, role: 'director' | 'member') => {
    const { error } = await db.from('users').update({ company_id: bankCompanyId, company_role: role }).eq('id', users[persona].id);
    if (error) throw new Error(`seating ${persona} failed: ${error.message}`);
  };
  await seat('alice', 'director');
  await seat('colleague', 'member');
  await seat('bob', 'member');

  const graph = await db.from('graph_reader_registrations').insert({
    tenant_id: TENANT,
    ms_tenant_id: 'fixture',
    client_id: 'fixture',
    status: 'active',
    mailbox_domains: ['bank.example'],
    firm_company_id: bankCompanyId,
  });
  if (graph.error) throw new Error(`graph registration failed: ${graph.error.message}`);
  const google = await db.from('google_reader_registrations').insert({
    tenant_id: TENANT,
    workspace_domain: 'bank.example',
    service_account_email: 'canary-reader@conductia-replay.iam.gserviceaccount.com',
    client_id: '100000000000000000002',
    directory_service_account_email: 'canary-directory@conductia-replay.iam.gserviceaccount.com',
    allowlist_group: 'conductia-ingest@bank.example',
    firm_company_id: bankCompanyId,
    status: 'active',
    consented_at: new Date().toISOString(),
  });
  if (google.error) throw new Error(`google registration failed: ${google.error.message}`);

  const invites = await db.from('invites').insert(
    MAILBOXES.map(({ address, owner }) => ({
      tenant_id: TENANT,
      email: address,
      invited_by: users.alice.id,
      company_id: bankCompanyId,
      company_role: 'member',
      status: 'accepted',
      delivery_status: 'sent',
      accepted_at: new Date().toISOString(),
      accepted_user_id: users[owner].id,
    })),
  );
  if (invites.error) throw new Error(`invites failed: ${invites.error.message}`);
  // The sources go in first, each owned by its mailbox's user: the one-click opt-in binds an owned source and
  // creates nothing (and, with both providers registered on bank.example, would create none here anyway).
  // Inserting after the opt-in would collide with a source the opt-in created.
  const sources = await db.from('content_sources').insert(
    MAILBOXES.map(({ address, owner, provider }) => ({
      tenant_id: TENANT,
      kind: 'mailbox',
      provider,
      address,
      owner_user_id: users[owner].id,
    })),
  );
  if (sources.error) throw new Error(`content sources failed: ${sources.error.message}`);
  // The opt-in needs MD or deal team on a deal of the tenant (#262 round 3, A2).
  await seatOnDeal(db, {
    tenantId: TENANT,
    bankId: bankCompanyId,
    code: `DD-CANARY-${RUN}`,
    userIds: (Object.keys(users) as Persona[]).map((persona) => users[persona].id),
  });
  for (const persona of Object.keys(users) as Persona[]) {
    const { error } = await sessions.get(persona)!.rpc('mailbox_consent_grant');
    if (error) throw new Error(`consent for ${persona} failed: ${error.message}`);
  }
});

afterAll(async () => {
  if (previousMfa === undefined) delete process.env.MFA_ENFORCEMENT;
  else process.env.MFA_ENFORCEMENT = previousMfa;
  delete process.env.DISCOVERY_GMAIL_REPLAY_DIR;
  rmSync(scratch, { recursive: true, force: true });

  await db.from('deal_candidates').delete().eq('tenant_id', TENANT);
  await db.from('source_items').delete().eq('tenant_id', TENANT);
  // A registration with sources cannot be deleted (on delete restrict): sources first.
  await db.from('content_sources').delete().eq('tenant_id', TENANT);
  await db.from('graph_reader_registrations').delete().eq('tenant_id', TENANT);
  await db.from('google_reader_registrations').delete().eq('tenant_id', TENANT);
  await db.from('mailbox_allowlist_drift').delete().eq('tenant_id', TENANT);
  await db.from('notifications').delete().eq('tenant_id', TENANT);
  await db.from('invites').delete().eq('tenant_id', TENANT);
  // The deal references the bank company; its memberships go with it.
  await db.from('deals').delete().eq('tenant_id', TENANT);
  for (const client of sessions.values()) await client.auth.signOut();
  for (const user of Object.values(users).reverse()) {
    if (!user.id) continue;
    const { error } = await db.auth.admin.deleteUser(user.id);
    // A user who wrote a user-actor audit row (a consent) cannot be deleted: suspend and unseat.
    if (error) await db.from('users').update({ status: 'suspended', company_id: null, company_role: null }).eq('id', user.id);
  }
  if (bankCompanyId) await db.from('companies').delete().eq('id', bankCompanyId);
  if (previousFlag) await setFlag(previousFlag.enabled);
  else await db.from('feature_flags').delete().eq('key', 'deal_discovery');
});

/** Everything written to console, stdout and stderr while `work` runs. */
async function captured<T>(work: () => Promise<T>): Promise<{ result: T; output: string }> {
  const chunks: string[] = [];
  const record = (...args: unknown[]) => {
    chunks.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.stack ?? a.message}` : JSON.stringify(a))).join(' '));
  };
  const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((level) => vi.spyOn(console, level).mockImplementation(record));
  const write = (stream: NodeJS.WriteStream) =>
    vi.spyOn(stream, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as never);
  const streams = [write(process.stdout), write(process.stderr)];
  try {
    return { result: await work(), output: chunks.join('\n') };
  } finally {
    for (const spy of [...spies, ...streams]) spy.mockRestore();
  }
}

describe('the canary: a non-deal message is read, and kept nowhere (both providers)', () => {
  let output = '';
  let itemsRead = 0;
  let itemsStored = 0;
  let summary: RunSummary | null = null;

  beforeAll(async () => {
    const { result, output: text } = await captured(async () => {
      // Control: the capture sees all three channels, so its silence about the canary means something.
      console.log('capture-control-console');
      process.stdout.write('capture-control-stdout');
      process.stderr.write('capture-control-stderr');
      return runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });
    });
    output = text;
    if (result.status !== 'ok') throw new Error(`pass skipped: ${result.reason}`);
    expect(result.refused).toEqual([]);
    itemsRead = result.itemsRead;
    itemsStored = result.itemsStored;
    summary = result;
  });

  it('is in no part of the line classify-once prints, whose Routing counts hold both canaries as unrouted (#460)', () => {
    if (summary?.status !== 'ok') throw new Error('unreachable');
    const { read, routed, unrouted, skipped, collisions } = summary.routing;
    expect(routed + unrouted + skipped + collisions).toBe(read);
    expect(read).toBe(itemsRead);
    expect(unrouted).toBeGreaterThanOrEqual(2);
    const line = summaryLine(summary);
    expect(line).toContain('Routing (full read): ');
    for (const fragment of [CANARY, ...CANARY_CONTENT, ...CANARY_MESSAGE_IDS, '@']) expect(line.includes(fragment), fragment).toBe(false);
  });

  it('actually read the canary through both readers, so the checks below are not vacuous', () => {
    // Graph: Storm's 8 + canary, Alex's 3. Gmail (phase seeded): Morgan's 5 seeded copies + canary.
    expect(itemsRead).toBe(9 + 3 + 6);
    // The canary messages are unrouted and never stored: Falcon and Cobra evidence only.
    expect(itemsStored).toBeGreaterThan(0);
    expect(itemsStored).toBeLessThan(itemsRead);
  });

  // Content (the marker, the subject, the body) is in no table at all. A message's
  // RFC 5322 Message-ID is a different thing: an identifier its sending server
  // chose, not something a person wrote. #243 keeps it, and the thread id built
  // from it, on the ledger row of an UNROUTED message and nowhere else, so the
  // eval can tell a reply read ahead of its codename from a true miss
  // (persist.ts ledgerRows; discovery-resume.test.ts, case 4, holds it for
  // Graph). It is not the provider item id: Gmail's is an opaque per-mailbox
  // hash, Graph's an opaque string. So the canary's Message-IDs may be in
  // routing_ledger.internet_message_id and .conversation_id, and in no other
  // column of any table.
  const CONTENT = CANARY_CONTENT;
  const MESSAGE_IDS = CANARY_MESSAGE_IDS;
  // Inside the stack's own database container, so the client always matches the server
  // (support/pgDump.ts); a failure carries pg_dump's stderr.
  const dumpOf = (...extra: string[]) => dumpData(process.env.DATABASE_URL as string, extra);

  it.skipIf(!process.env.DATABASE_URL)('holds no content of it in any table (pg_dump --data-only), and the dump is not blind', () => {
    const dump = dumpOf();
    expect(dump.includes('Project Falcon')).toBe(true);
    expect(dump.includes('Project Cobra')).toBe(true);
    expect(dump.includes(CANARY)).toBe(false);
    for (const fragment of CONTENT) expect(dump.includes(fragment), fragment).toBe(false);
  });

  it.skipIf(!process.env.DATABASE_URL)('holds its Message-ID in no table but the ledger row of an unrouted message', async () => {
    // Everywhere except routing_ledger: not in one row of one table.
    const elsewhere = dumpOf('--exclude-table-data=public.routing_ledger');
    expect(elsewhere.includes('Project Falcon'), 'the dump without the ledger is not blind').toBe(true);
    for (const fragment of MESSAGE_IDS) expect(elsewhere.includes(fragment), fragment).toBe(false);

    // Inside routing_ledger: only the two identifier columns of unrouted rows, never the provider item id.
    const sources = await db.from('content_sources').select('id').eq('tenant_id', TENANT);
    const { data, error } = await db
      .from('routing_ledger')
      .select('provider_item_id, decision, method, conversation_id, internet_message_id, item_hash')
      .in('source_id', (sources.data ?? []).map((r) => r.id as string));
    expect(error).toBeNull();
    const rows = data ?? [];
    const holding = rows.filter((r) => MESSAGE_IDS.some((fragment) => JSON.stringify(r).includes(fragment)));
    // The control: both canaries are ledgered, so this check is not vacuous.
    expect(holding.map((r) => r.internet_message_id).sort()).toEqual(['<canary-gmail@bank.example>', '<canary-graph@bank.example>']);
    for (const row of holding) {
      expect(row).toMatchObject({ decision: 'unrouted', method: null });
      // The provider item id is the reader's own opaque id, never derived from the Message-ID.
      for (const fragment of MESSAGE_IDS) expect(row.provider_item_id, fragment).not.toContain(fragment);
      // Nothing else on the row names it: the other columns are hashes and enum values.
      const rest = { provider_item_id: row.provider_item_id, decision: row.decision, method: row.method, item_hash: row.item_hash };
      for (const fragment of MESSAGE_IDS) expect(JSON.stringify(rest), fragment).not.toContain(fragment);
    }
    // A routed item's Message-ID is on source_items, and these two never are there (elsewhere, above).
    expect(rows.filter((r) => r.decision === 'routed').every((r) => r.internet_message_id === null)).toBe(true);
    // The message index (#461) holds both, as their hashed key only (owner 2026-10-17): the dump above finds no raw id.
    const { data: indexed } = await db.from('discovery_message_index').select('message_key').eq('tenant_id', TENANT);
    const keys = (indexed ?? []).map((r) => r.message_key);
    expect(keys).toEqual(expect.arrayContaining(['<canary-gmail@bank.example>', '<canary-graph@bank.example>'].map(messageKey)));
  });

  it('is in nothing the worker or the readers printed', () => {
    for (const control of ['capture-control-console', 'capture-control-stdout', 'capture-control-stderr']) {
      expect(output.includes(control), control).toBe(true);
    }
    expect(output.includes(CANARY)).toBe(false);
    expect(output.includes('Parking notice')).toBe(false);
    expect(output.includes('Kitchen rota')).toBe(false);
    // Nor either canary's Message-ID: the worker prints no identifier of a message it read.
    for (const fragment of ['canary-gmail@', 'canary-graph@']) expect(output.includes(fragment), fragment).toBe(false);
  });

  // The reader pass record (#370): ids, codes, counts and times only.
  it('is in no reader pass row: each source has a start and an end, and neither carries content', async () => {
    const { data, error } = await db
      .from('audit_log')
      .select('action, detail')
      .eq('tenant_id', TENANT)
      .like('action', 'discovery.reader_pass_%');
    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{ action: string; detail: Record<string, unknown> }>;
    // Not vacuous: a start and an end per source (two Graph mailboxes and one Gmail mailbox).
    expect(rows.filter((row) => row.action === 'discovery.reader_pass_started')).toHaveLength(3);
    expect(rows.filter((row) => row.action === 'discovery.reader_pass_finished')).toHaveLength(3);
    const text = JSON.stringify(rows);
    expect(text.includes(CANARY)).toBe(false);
    for (const fragment of [...CANARY_CONTENT, ...CANARY_MESSAGE_IDS, 'Project Falcon', 'Project Cobra', '@bank.example']) {
      expect(text.includes(fragment), fragment).toBe(false);
    }
  });

  it('is not in the line the worker prints when a pass end cannot be recorded, even when the database error quotes it', async () => {
    // The end RPC answers with an error whose message quotes the canary: only its code may be printed.
    const failing = new Proxy(db, {
      get(target, prop) {
        if (prop === 'rpc') {
          return (name: string, args: { p_event?: string }) => {
            if (args?.p_event !== 'finished') return target.rpc(name, args);
            const answer = Promise.resolve({ data: null, error: { code: 'XX000', message: `could not write ${CANARY}` } });
            return Object.assign(answer, { abortSignal: () => answer });
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as SupabaseClient;
    const { result, output: printed } = await captured(() => runOnce({ tenantId: TENANT, db: failing, provider: READER_MODE.FIXTURE }));
    expect(result.status).toBe('ok');
    expect(printed).toContain('discovery worker: reader pass end not recorded (XX000)');
    expect(printed.includes(CANARY)).toBe(false);
  });

  it('is not in a GoogleHttpError, even when Google answers 500 on the canary message and the body quotes it', async () => {
    const replays = readdirSync(gmailDir)
      .filter((f) => f.endsWith('.replay.json'))
      .map((f) => JSON.parse(readFileSync(join(gmailDir, f), 'utf8')) as GmailReplay);
    const morgan = replays.find((r) => r.mailbox === 'morgan.vale@bank.example') as GmailReplay;
    const rawKey = Object.entries(morgan.phases.seeded).find(
      ([key, list]) =>
        key.includes('format=raw') &&
        Buffer.from(String((list[list.length - 1].body as { raw?: string }).raw), 'base64url').toString('utf8').includes(CANARY),
    )?.[0];
    expect(rawKey, 'the canary message is in Morgan\'s replay').toBeDefined();
    morgan.phases.seeded[rawKey as string] = [
      { status: 500, synthetic: true, body: { error: { code: 500, message: `Backend error while reading ${CANARY}`, status: 'INTERNAL' } } },
    ];

    const reader = createGmailMailContentSource({
      httpFor: async () => ({ getToken: async () => 'replay', fetchImpl: replayFetch(replays, 'seeded'), sleep: async () => undefined, maxAttempts: 2 }),
      exclusion: NO_EXCLUSION,
    });
    const error = await (async () => {
      for await (const page of reader.backfill({
      id: '33333333-3333-4333-8333-333333333333',
      tenantId: TENANT,
      kind: SOURCE_KIND.MAILBOX,
      provider: MAILBOX_PROVIDER.GOOGLE,
      address: 'morgan.vale@bank.example',
      ownerUserId: users.colleague.id,
      deltaCheckpoint: null,
    }, null)) void page;
    })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleHttpError);
    expect(error).toMatchObject({ status: 500, reason: 'INTERNAL' });
    const shown = `${(error as Error).message}\n${(error as Error).stack}\n${JSON.stringify(error)}`;
    expect(shown.includes(CANARY)).toBe(false);
  });
});

// Demo-only (#460; delete with #459): the canary through classify-once --propose. The step's model (a test double
// here, so both canaries get an answer: the stub covers the demo corpus only) is handed the canary's text in memory
// and answers "not deal". Its row is a hash, a date, domains and the outcome: the canary's content and Message-ID are
// still in no table but its unrouted ledger row, and in nothing the worker printed.
describe('the canary through a propose run: the model is asked, and still nothing keeps it (#460)', () => {
  let output = '';
  let summary: RunSummary | null = null;
  let previousPropose: { enabled: boolean } | null = null;
  const model = proposeReplyDouble(() => ({ deal_related: false, p_deal: 0.02, deal: null, phase: null, p_phase: 0 }));

  beforeAll(async () => {
    const { data } = await db.from('feature_flags').select('enabled').eq('key', PROPOSE_FLAG).maybeSingle();
    previousPropose = data as { enabled: boolean } | null;
    const flag = await db
      .from('feature_flags')
      .upsert({ key: PROPOSE_FLAG, description: 'demo model proposals (integration)', enabled: true }, { onConflict: 'key' });
    if (flag.error) throw new Error(`flag upsert failed: ${flag.error.message}`);
    const { result, output: text } = await captured(async () => {
      console.log('capture-control-console');
      return runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE, propose: { transport: model } });
    });
    output = text;
    summary = result;
  });

  afterAll(async () => {
    if (previousPropose) {
      await db.from('feature_flags').update({ enabled: previousPropose.enabled }).eq('key', PROPOSE_FLAG);
    } else {
      await db.from('feature_flags').delete().eq('key', PROPOSE_FLAG);
    }
  });

  it('asked the model about both canaries, so the checks below are not vacuous', () => {
    if (summary?.status !== 'ok') throw new Error(`propose run did not read: ${summary?.status}`);
    expect(summary.proposed).toMatchObject({ failed: 0, invalid: 0, deal: 0 });
    expect(model.sent.filter((s) => s.input.subject.includes(CANARY))).toHaveLength(2);
  });

  it('leaves each canary a not_deal row of hashes, domains and the outcome alone', async () => {
    const { data, error } = await db
      .from('discovery_model_proposals')
      .select('*')
      .eq('tenant_id', TENANT)
      .in('message_key', ['<canary-gmail@bank.example>', '<canary-graph@bank.example>'].map(messageKey));
    expect(error).toBeNull();
    expect(data).toHaveLength(2);
    for (const row of data ?? []) {
      expect(row).toMatchObject({ outcome: 'not_deal', deal_key: null, deal_name: null, phase: null, party_domains: [] }); // bank.example is the firm's own (#460 A3)
    }
  });

  it('is in nothing the propose run printed, its line included', () => {
    if (summary?.status !== 'ok') throw new Error('unreachable');
    expect(output.includes('capture-control-console')).toBe(true);
    const line = summaryLine(summary);
    expect(line).toMatch(/ Proposed: called \d+, deal 0, new names 0, not deal \d+, failed 0, invalid 0, cost \$0\.0000, sources skipped \d+, sources refused 0\.$/);
    for (const fragment of [CANARY, ...CANARY_CONTENT, ...CANARY_MESSAGE_IDS]) {
      expect(output.includes(fragment), fragment).toBe(false);
      expect(line.includes(fragment), fragment).toBe(false);
    }
  });

  const dumpOf = (...extra: string[]) => dumpData(process.env.DATABASE_URL as string, extra);

  it.skipIf(!process.env.DATABASE_URL)('holds no content of it in any table, and its Message-ID only on the ledger', () => {
    const dump = dumpOf();
    expect(dump.includes('Project Falcon'), 'the dump is not blind').toBe(true);
    expect(dump.includes(CANARY)).toBe(false);
    for (const fragment of CANARY_CONTENT) expect(dump.includes(fragment), fragment).toBe(false);
    const elsewhere = dumpOf('--exclude-table-data=public.routing_ledger');
    // Not blind to the proposal table: the canaries' hashed keys are there.
    expect(elsewhere.includes(messageKey('<canary-graph@bank.example>'))).toBe(true);
    for (const fragment of CANARY_MESSAGE_IDS) expect(elsewhere.includes(fragment), fragment).toBe(false);
  });
});

describe('the canary: what the admin sees after a failed read (R23, admin health)', () => {
  it('leaves one content-free last_error, and the admin health payload carries no content', async () => {
    // Read Morgan's mailbox again from nothing, with Google answering 500 on the canary message
    // and quoting it in the body: the worst case for a leak through the error.
    const file = join(gmailDir, twinFileName('morgan.vale@bank.example'));
    const replay = JSON.parse(readFileSync(file, 'utf8')) as GmailReplay;
    const rawKey = Object.entries(replay.phases.seeded).find(
      ([key, list]) =>
        key.includes('format=raw') &&
        Buffer.from(String((list[list.length - 1].body as { raw?: string }).raw), 'base64url').toString('utf8').includes(CANARY),
    )?.[0];
    expect(rawKey, "the canary message is in Morgan's replay").toBeDefined();
    replay.phases.seeded[rawKey as string] = [
      { status: 500, synthetic: true, body: { error: { code: 500, message: `Backend error while reading ${CANARY}`, status: 'INTERNAL' } } },
    ];
    writeFileSync(file, JSON.stringify(replay));
    const reset = await db
      .from('content_sources')
      .update({ delta_checkpoint: null, backfill_completed_at: null, checkpoint_updated_at: null })
      .eq('tenant_id', TENANT)
      .eq('address', 'morgan.vale@bank.example');
    expect(reset.error).toBeNull();

    const { result, output } = await captured(() =>
      runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE }).catch((e: unknown) => e),
    );
    expect(result).toBeInstanceOf(GoogleHttpError);
    expect(output.includes(CANARY)).toBe(false);

    const morgan = await db
      .from('content_sources')
      .select('last_error, last_error_at')
      .eq('tenant_id', TENANT)
      .eq('address', 'morgan.vale@bank.example')
      .single();
    expect(morgan.data?.last_error).toBe('Google 500 INTERNAL');
    expect(morgan.data?.last_error_at).not.toBeNull();

    // The firm admin reads the health view. Alice is the bank's director; make her its admin for this read only.
    const promote = await db.from('users').update({ firm_role: 'admin' }).eq('id', users.alice.id);
    expect(promote.error).toBeNull();
    try {
      const health = await readIngestionHealth(sessions.get('alice')!);
      expect(health.ok, 'the admin reads health').toBe(true);
      if (!health.ok) return;
      const text = JSON.stringify(health.health);

      // Not vacuous: the payload carries the error line, the providers and the admin's control.
      const source = health.health.sources.find((row) => row.address === 'morgan.vale@bank.example');
      expect(source).toMatchObject({ provider: 'google', archived: false, lastError: 'Google 500 INTERNAL', waitingFor: null });
      expect(health.health.sources.map((row) => row.provider).sort()).toEqual(['google', 'microsoft', 'microsoft']);
      expect(health.health.registrations.map((row) => row.provider).sort()).toEqual(['google', 'microsoft']);
      expect(health.health.viewerCanManageSources).toBe(true);
      expect(health.health.reconciliation).toBe('not_built');

      // The failed read's pass (#370): its outcome and a code, and the 24-hour line, beside the error line.
      expect(source?.latestPass).toMatchObject({ state: 'ended', group: 'failed', status: 'failed', reason: 'google_500' });
      expect(health.health.totals.passesLast24h?.failed).toBeGreaterThanOrEqual(1);

      // And none of the content: not the marker, a subject, a body or a Message-ID.
      expect(text.includes(CANARY)).toBe(false);
      for (const fragment of [...CANARY_CONTENT, ...CANARY_MESSAGE_IDS, 'Project Falcon', 'Project Cobra']) {
        expect(text.includes(fragment), fragment).toBe(false);
      }
      // No checkpoint string, participant or party leaves the function either.
      expect(text).not.toMatch(/"(deltaCheckpoint|participants|subject|parties)"/);
    } finally {
      await db.from('users').update({ firm_role: null }).eq('id', users.alice.id);
    }
  });
});
