// First import, on purpose: it claims the reader capability before any other
// module loads (tests/mailbox-access/boot-claim.test.ts pins the order).
import '../src/lib/mailboxAccess/readers';

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { DEV_TENANT_ID } from '../src/lib/db/tenant';
import {
  MAILBOX_PROVIDER,
  READER_MODE,
  REGISTRATION_STATUS,
  SOURCE_KIND,
  SOURCE_STATUS,
  TEAM_MAILBOX_ATTESTATION_VERSION,
  type MailboxProvider,
} from '../src/lib/constants/discovery';
import { INVITE_DELIVERY_STATUS, INVITE_STATUS } from '../src/lib/constants/invites';
import { COMPANY_ROLE } from '../src/lib/constants/roles';
import { TABLE } from '../src/lib/constants/tables';
import type { PolicyRule } from '../src/lib/discovery/exclusion/types';
import { runOnce } from '../worker/classify';
import {
  DEMO_TEAM_INBOX,
  fixtureDirectoryUserId,
  selectCorpus,
  selectPersonas,
  selectTeamInbox,
  type CorpusSelection,
  type TeamInboxSelection,
} from './discovery/lib/corpusSelect';
import { ensureDemoExclusionPolicy, openSeedDb } from './discovery/lib/demoPolicy';
import { seedEmail } from './seed-data';
import { applyGoogleRegistration, parseGoogleRegistrationConfig, registrationDbFor } from './google/write-registration';

// Dev and E2E seed for deal discovery (phase 3). Registers a fixture Graph
// reader for the dev tenant, maps the fixture corpus's mailboxes
// (tests/fixtures/discovery/*.json) to seed-users personas, and runs the
// classification worker once. Idempotent: re-running changes nothing.
//
// Run after seed-users, against the same stack:
//   npm run seed:discovery
//   npm run seed:discovery -- --corpus demo [--phase seeded|after-imports]
//
// --corpus base|demo (default base) and --phase seeded|after-imports (default
// seeded) choose which committed fixture directory the fixture reader serves
// (DISCOVERY_FIXTURE_DIR, refused in prod): the demo corpus is Kestrel, Harbor
// and Osprey beside the noise, and after-imports adds the late mail.
//
// The personas: Storm Duncan (md) and Morgan Vale (ib-director) both hold
// Project Falcon mail, and only Morgan holds Project Cobra's. Alex Chen
// (deal-team) has a mailbox with no deal mail at all, so he sees no
// candidate. The CCO sees both; the firm admin sees neither.
//
// It also gives each fixture owner an accepted invite plus an opt-in, so the
// allowlist (#262) admits their mailbox. The opt-in is the owner's own act:
// the seed signs in as each owner (SEED_PASSWORD, as seed:users set it) and
// calls mailbox_consent_grant() under that session, because no other writer
// can insert a consent (audit round 1, item 14). The opt-in also needs MD or deal
// team on a deal of the tenant (round 3, A2): the three owners are, on the seeded
// deals (Atlas: md and deal-team; Summit: ib-director), so seed:users comes first.
//
// With `--google <registration.json>` (#259) it instead seeds a local Google
// tenant from the file scripts/google/write-registration.ts reads: the Google
// registration, the Google content_sources, and for each source's owner an
// accepted invite (email = the mailbox address) plus consent under the owner's
// own session. The owners are seed users, so their emails come from seed:users.
// It does not classify: the worker reads the real mailboxes, on the owner's
// machine, with DISCOVERY_READER_MODE=live npm run worker:classify.
//
// With `--google-replay` (#259 phase 6) it seeds the same dev tenant with the
// fixture personas as GOOGLE sources and classifies them once through the real
// Gmail reader over a replay: no trial, no credential, no network.
//
//   npm run seed:discovery -- --google-replay
//   npm run seed:discovery -- --google-replay --corpus demo --phase seeded   (the demo mail)
//
// With `--team-inbox <address>` (#581, Gmail replay with --corpus demo only) it also registers the team inbox the way
// its admin would (the connect RPC under the seeded firm admin's own session), records its Directory check as
// verified, and adds each `--team-members` persona (storm, morgan, alex) as a member. `--personas morgan,...` seeds
// only those personas' own mailboxes, so a persona left out has no personal copy of the mail and sees the team
// inbox's only as a member. The team inbox journey seeds `--personas morgan` and connects the inbox through the card.
//
//   npm run seed:discovery -- --google-replay --corpus demo --personas morgan --team-inbox deals@bank.example --team-members storm
//
// The replay is the committed synthetic twin unless DISCOVERY_GMAIL_REPLAY_DIR
// names another directory (the Tidewell recording stays outside the repo, and
// its personas are named with `--owner <address>=<seed owner slug>`). It is read
// in its last phase, after-unspam, when a mailbox holds the whole corpus, unless
// DISCOVERY_GMAIL_REPLAY_PHASE says otherwise. It moves the fixture tenant's
// sources to Google: an address has one provider (F5), and the personas are seed
// users of the dev tenant, so the Gmail view is the Graph view of the same
// corpus. Run without the flag to switch them back. The move follows #262's
// source lifecycle (placeMailboxSource): a source with no history flips in
// place; one that holds the other provider's items is archived with them and a
// fresh source is created; an archived row is never written to.

export const FIXTURE_MAILBOX_OWNERS: Array<{ address: string; ownerSlug: string }> = [
  { address: 'storm.duncan@bank.example', ownerSlug: 'md' },
  { address: 'morgan.vale@bank.example', ownerSlug: 'ib-director' },
  { address: 'alex.chen@bank.example', ownerSlug: 'deal-team' },
];

/**
 * #262: a mailbox is read only for an invite-seated bank member who opted in.
 * The seed users have no invites, so this writes an accepted invite (email =
 * the mailbox address, R4) and an open consent, the consent under the owner's
 * own session: mailbox_consents_audit writes the audit row in the same
 * statement, naming them as the actor. Idempotent.
 */
async function ensureInviteAndConsent(args: {
  db: SupabaseClient;
  url: string;
  publishableKey: string;
  password: string;
  tenantId: string;
  firmCompanyId: string;
  address: string;
  owner: { id: string; email: string };
}): Promise<void> {
  const { db, url, publishableKey, password, tenantId, firmCompanyId, address, owner } = args;
  let { data: invite } = await db
    .from(TABLE.INVITES)
    .select('id')
    .eq('email', address)
    .eq('accepted_user_id', owner.id)
    .eq('status', INVITE_STATUS.ACCEPTED)
    .maybeSingle();
  if (!invite) {
    const inserted = await db
      .from(TABLE.INVITES)
      .insert({
        tenant_id: tenantId,
        email: address,
        invited_by: owner.id,
        company_id: firmCompanyId,
        company_role: COMPANY_ROLE.MEMBER,
        status: INVITE_STATUS.ACCEPTED,
        delivery_status: INVITE_DELIVERY_STATUS.SENT,
        accepted_at: new Date().toISOString(),
        accepted_user_id: owner.id,
      })
      .select('id')
      .single();
    if (inserted.error) throw inserted.error;
    invite = inserted.data;
  }
  const { data: open } = await db
    .from(TABLE.MAILBOX_CONSENTS)
    .select('id')
    .eq('invite_id', invite!.id)
    .is('withdrawn_at', null)
    .maybeSingle();
  if (!open) {
    // The owner opts in under their own session; mailbox_consents_audit
    // writes the audit row in the same statement, naming them as the actor.
    const session = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const signIn = await session.auth.signInWithPassword({ email: owner.email, password });
    if (signIn.error) throw new Error(`Seed user ${owner.email} could not sign in: ${signIn.error.message}`);
    const consent = await session.rpc('mailbox_consent_grant');
    await session.auth.signOut();
    if (consent.error) {
      // not_eligible: no seat, an unregistered domain, or (A2) not MD or deal team on any deal of the tenant.
      const hint = consent.error.message === 'not_eligible' ? ' (the owner must be MD or deal team on a deal: run seed:users)' : '';
      throw new Error(`Consent for ${owner.email} failed: ${consent.error.message}${hint}`);
    }
  }
}

export type Placement = 'created' | 'updated' | 'flipped' | 'archived_and_created';

/**
 * Puts the mailbox source of an address on one provider for the seed, under #262's source lifecycle. The one-click
 * opt-in (mailbox_consent_grant) would create or adopt the source itself, but not here: the dev tenant's domain is
 * registered with both providers, so the opt-in leaves the choice of provider to the operator, which is this seed.
 *
 *   - No live source: one is created for the owner. An archived row (an orphaned mailbox kept with its history,
 *     renamed <address>~xyz) is never matched, so it is never written to, resumed or re-owned.
 *   - A live source on this provider: its owner and status are set, its checkpoint kept.
 *   - A live source on the other provider with no history: the provider flips in place and its sync state is
 *     cleared (a delta link of one provider means nothing to the other), so it backfills afresh.
 *   - A live source on the other provider that holds provenance rows: the items it holds were read through the
 *     other provider, and a source never carries another provider's history (the unify rule, #262). It is archived
 *     as the opt-in archives an orphan (renamed, paused, ownerless, stamped; the guard's last refusal is
 *     forgotten), and a fresh source is created. Switching back and forth is therefore lossless, not a rewrite.
 *
 * Every write is conditional on the row still being the live source of its address and provider, since an opt-in can
 * archive it between the lookup and the write; a write that matches nothing looks the address up again.
 */
export async function placeMailboxSource(
  db: SupabaseClient,
  args: { tenantId: string; address: string; ownerId: string; provider: MailboxProvider },
): Promise<Placement> {
  const { tenantId, address, ownerId, provider } = args;
  // backfill_since null: a fixture mailbox is read whole, whatever the column's default (#353); its corpus has fixed dates.
  const fresh = {
    tenant_id: tenantId,
    kind: SOURCE_KIND.MAILBOX,
    provider,
    address,
    owner_user_id: ownerId,
    status: SOURCE_STATUS.ACTIVE,
    backfill_since: null,
  };
  let archivedOne = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, error } = await db
      .from(TABLE.CONTENT_SOURCES)
      .select('id, provider, address')
      .eq('tenant_id', tenantId)
      .eq('kind', SOURCE_KIND.MAILBOX)
      .is('archived_at', null);
    if (error) throw error;
    const live = ((data ?? []) as Array<{ id: string; provider: MailboxProvider; address: string }>).find(
      (row) => row.address.toLowerCase() === address.toLowerCase(),
    );

    if (!live) {
      const inserted = await db.from(TABLE.CONTENT_SOURCES).insert(fresh);
      if (!inserted.error) return archivedOne ? 'archived_and_created' : 'created';
      if (inserted.error.code !== '23505') throw inserted.error;
      continue; // another writer took the address: look it up again
    }

    // Matched on the id, the exact address, the provider seen and archived_at null: the row is still that live source.
    const written = async (fields: Record<string, unknown>): Promise<boolean> => {
      const { data: hit, error: writeError } = await db
        .from(TABLE.CONTENT_SOURCES)
        .update(fields)
        .eq('id', live.id)
        .eq('address', live.address)
        .eq('provider', live.provider)
        .is('archived_at', null)
        .select('id');
      if (writeError) throw writeError;
      return (hit ?? []).length > 0;
    };

    if (live.provider === provider) {
      if (await written({ owner_user_id: ownerId, status: SOURCE_STATUS.ACTIVE })) return 'updated';
      continue;
    }
    // History is what the source's reads left: provenance rows and the routing ledger (a hash and a decision per item).
    const history = await Promise.all([
      db.from(TABLE.SOURCE_ITEM_SOURCES).select('content_source_id', { count: 'exact', head: true }).eq('content_source_id', live.id),
      db.from(TABLE.ROUTING_LEDGER).select('source_id', { count: 'exact', head: true }).eq('source_id', live.id),
    ]);
    for (const { error: historyError } of history) if (historyError) throw historyError;
    if (history.every(({ count }) => (count ?? 0) === 0)) {
      // The sync state is the other provider's too (a Graph delta link means nothing to Gmail): a flip starts a fresh
      // backfill, as the opt-in's adoption does.
      const flip = {
        provider,
        owner_user_id: ownerId,
        status: SOURCE_STATUS.ACTIVE,
        delta_checkpoint: null,
        backfill_started_at: null,
        backfill_completed_at: null,
        checkpoint_updated_at: null,
        last_synced_at: null,
        last_error: null,
        last_error_at: null,
        history_expiry_streak: 0,
      };
      if (await written(flip)) return 'flipped';
      continue;
    }
    let archived = false;
    for (let draw = 0; draw < 20 && !archived; draw++) {
      const suffix = Array.from({ length: 3 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
      const renamed = await db
        .from(TABLE.CONTENT_SOURCES)
        .update({
          address: `${live.address}~${suffix}`,
          status: SOURCE_STATUS.PAUSED,
          owner_user_id: null,
          archived_at: new Date().toISOString(),
          archived_from_address: live.address,
        })
        .eq('id', live.id)
        .eq('address', live.address)
        .eq('provider', live.provider)
        .is('archived_at', null)
        .select('id');
      if (renamed.error) {
        if (renamed.error.code === '23505') continue; // that suffix is taken: draw another
        throw renamed.error;
      }
      if ((renamed.data ?? []).length === 0) break; // archived or changed since the lookup: look it up again
      archived = true;
    }
    if (!archived) continue;
    archivedOne = true;
    // What the earlier source's reads were last refused for says nothing of the fresh one (as the opt-in does).
    const { error: stateError } = await db.from(TABLE.MAILBOX_GUARD_STATE).delete().eq('tenant_id', tenantId).eq('address', address.toLowerCase());
    if (stateError) throw stateError;
  }
  throw new Error(`Mailbox source ${address} kept changing while it was placed; run the seed again`);
}

/**
 * `--google <registration.json>`: a local Google tenant, seeded the way the
 * fixture tenant is. Every source owner must be a seed user seated in the
 * registration's firm company.
 */
async function seedGoogle(
  file: string,
  ctx: { db: SupabaseClient; url: string; publishableKey: string; password: string },
): Promise<void> {
  const parsed = parseGoogleRegistrationConfig(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.ok) throw new Error(`Invalid registration:\n- ${parsed.errors.join('\n- ')}`);
  const config = parsed.config;
  if (config.sources.length === 0) throw new Error('The registration lists no sources: nothing to seed');

  const owners = new Map<string, string>();
  for (const { address, ownerEmail } of config.sources) {
    const { data, error } = await ctx.db
      .from(TABLE.USERS)
      .select('id, tenant_id, company_id')
      .eq('is_external', false)
      .ilike('email', ownerEmail)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(`Seed user ${ownerEmail} (owner of ${address}) is missing. Run seed:users first.`);
    if (data.tenant_id !== config.tenantId) {
      throw new Error(`Seed user ${ownerEmail} is not in tenant ${config.tenantId}: set tenantId to the dev tenant`);
    }
    if (data.company_id !== config.firmCompanyId) {
      throw new Error(`Seed user ${ownerEmail} is not seated in the firm company ${config.firmCompanyId}`);
    }
    owners.set(address, data.id as string);
  }

  const result = await applyGoogleRegistration(registrationDbFor(ctx.db), config);
  console.log(`Google registration for ${config.workspaceDomain} (${config.status}).`);
  for (const { address, action } of result.sources) console.log(`Source ${address}: ${action}`);

  for (const { address, ownerEmail } of config.sources) {
    await ensureInviteAndConsent({
      ...ctx,
      tenantId: config.tenantId,
      firmCompanyId: config.firmCompanyId,
      address,
      owner: { id: owners.get(address) as string, email: ownerEmail },
    });
    console.log(`Mailbox ${address} -> ${ownerEmail}: invited and consented`);
  }
  console.log(
    'Seeded. Nothing was classified: run DISCOVERY_READER_MODE=live npm run worker:classify ' +
      `-- --tenant ${config.tenantId} on the machine that holds the Google credential.`,
  );
}

/** The bank company the seed owners are all seated in. The first owner names it; a second bank in the tenant (Northwind) is never named. */
async function firmCompanyOf(db: SupabaseClient, ownerSlugs: string[]): Promise<string> {
  const seatOf = async (ownerSlug: string): Promise<string> => {
    const email = seedEmail(ownerSlug);
    const { data, error } = await db.from(TABLE.USERS).select('company_id').eq('email', email).maybeSingle();
    if (error) throw error;
    if (!data?.company_id) throw new Error(`Seed user ${email} has no company. Run seed:users first.`);
    return data.company_id as string;
  };
  const firmCompanyId = await seatOf(ownerSlugs[0]);
  for (const ownerSlug of ownerSlugs) {
    if ((await seatOf(ownerSlug)) !== firmCompanyId) {
      throw new Error(`Seed user ${seedEmail(ownerSlug)} is not seated in the firm company. Run seed:users first.`);
    }
  }
  return firmCompanyId;
}

/** Where the committed synthetic twin lives. The seed cannot import the reader that names it (the fence), so the path is repeated here. */
const TWIN_DIR = join(process.cwd(), 'tests', 'fixtures', 'discovery', 'gmail-twin');
/** The placeholder identities of a replay registration: shaped like real ones, naming no real service account or client. */
const REPLAY_REGISTRATION = {
  serviceAccountEmail: 'replay-reader@conductia-replay.iam.gserviceaccount.com',
  clientId: '100000000000000000001',
  directoryServiceAccountEmail: 'replay-directory@conductia-replay.iam.gserviceaccount.com',
  allowlistGroup: 'conductia-ingest@bank.example',
} as const;

/** Every mailbox address a replay directory holds, read as plain JSON (the reader that loads it demands the capability). */
export function replayMailboxes(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.replay.json'))
    .sort()
    .map((name) => (JSON.parse(readFileSync(join(dir, name), 'utf8')) as { mailbox: string }).mailbox.toLowerCase());
}

/** The persona addresses of a replay directory: its mailboxes except the demo team inbox, which no person owns. */
export function replayPersonas(dir: string): string[] {
  return replayMailboxes(dir).filter((address) => address !== DEMO_TEAM_INBOX);
}

/** A demo persona's short name: `storm.duncan@bank.example` is `storm`. */
const personaName = (address: string): string => address.split('.')[0];

/** `--owner <address>=<seed owner slug>` pairs, for a replay whose personas are not the fixture's. */
export function ownerOverrides(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  argv.forEach((arg, i) => {
    if (arg !== '--owner') return;
    const [address, slug] = (argv[i + 1] ?? '').split('=');
    if (!address || !slug) throw new Error('--owner needs <address>=<seed owner slug>');
    out.set(address.toLowerCase(), slug);
  });
  return out;
}

/**
 * `--google-replay`: the dev tenant's personas as Google sources, read once
 * through the real Gmail reader over a replay (fixture mode): the base twin at
 * `after-unspam`, or with `--corpus demo` the demo twin at `--phase`.
 */
async function seedGoogleReplay(
  argv: string[],
  ctx: {
    db: SupabaseClient;
    url: string;
    publishableKey: string;
    password: string;
    firmCompanyId: string;
    selection: CorpusSelection;
    /** The committed demo rules, read and validated by main's preflight before any write. */
    demoRules?: PolicyRule[];
    /** --personas: the persona names to seed (default all). */
    personas: string[] | null;
    /** --team-inbox: the team inbox to register after the personas. */
    team: TeamInboxSelection | null;
  },
): Promise<void> {
  const { db, firmCompanyId } = ctx;
  // --corpus demo has already pointed both at the demo twin and the selected phase (selectCorpus).
  // The base twin keeps after-unspam, the phase holding its whole corpus.
  const dir = process.env.DISCOVERY_GMAIL_REPLAY_DIR?.trim() || TWIN_DIR;
  process.env.DISCOVERY_GMAIL_REPLAY_PHASE = process.env.DISCOVERY_GMAIL_REPLAY_PHASE?.trim() || 'after-unspam';
  const overrides = ownerOverrides(argv);
  const slugFor = new Map([...FIXTURE_MAILBOX_OWNERS.map((o) => [o.address, o.ownerSlug] as const), ...overrides]);
  const personas = replayPersonas(dir);
  if (personas.length === 0) throw new Error(`No *.replay.json files in ${dir}`);
  const known = personas.map((address) => {
    const ownerSlug = slugFor.get(address);
    if (!ownerSlug) throw new Error(`No seed owner for ${address}: pass --owner ${address}=<seed owner slug>`);
    return { address, ownerSlug };
  });
  const wanted = ctx.personas;
  const unknownNames = (wanted ?? []).filter((name) => !known.some((o) => personaName(o.address) === name));
  if (unknownNames.length > 0) {
    throw new Error(`--personas names ${unknownNames.join(', ')}, not a persona of ${dir} (${known.map((o) => personaName(o.address)).join(', ')})`);
  }
  const owners = wanted ? known.filter((o) => wanted.includes(personaName(o.address))) : known;
  if (owners.length === 0) throw new Error('--personas names no persona');
  const domains = new Set(personas.map((a) => a.split('@')[1]));
  if (domains.size !== 1) throw new Error('The replay personas must share one domain');
  const [workspaceDomain] = [...domains];
  const firmOf = await firmCompanyOf(db, owners.map((o) => o.ownerSlug));
  if (firmOf !== firmCompanyId) throw new Error('The replay personas are not seated in the fixture firm');

  const { error: registrationError } = await db.from(TABLE.GOOGLE_READER_REGISTRATIONS).upsert(
    {
      tenant_id: DEV_TENANT_ID,
      workspace_domain: workspaceDomain,
      service_account_email: REPLAY_REGISTRATION.serviceAccountEmail,
      client_id: REPLAY_REGISTRATION.clientId,
      directory_service_account_email: REPLAY_REGISTRATION.directoryServiceAccountEmail,
      allowlist_group: `conductia-ingest@${workspaceDomain}`,
      firm_company_id: firmCompanyId,
      status: REGISTRATION_STATUS.ACTIVE,
      consented_at: new Date().toISOString(),
    },
    { onConflict: 'tenant_id' },
  );
  if (registrationError) throw registrationError;

  for (const { address, ownerSlug } of owners) {
    const email = seedEmail(ownerSlug);
    const { data: owner, error: ownerError } = await db.from(TABLE.USERS).select('id').eq('email', email).maybeSingle();
    if (ownerError) throw ownerError;
    if (!owner) throw new Error(`Seed user ${email} is missing. Run seed:users first.`);

    const placement = await placeMailboxSource(db, {
      tenantId: DEV_TENANT_ID,
      address,
      ownerId: owner.id as string,
      provider: MAILBOX_PROVIDER.GOOGLE,
    });

    await ensureInviteAndConsent({
      db,
      url: ctx.url,
      publishableKey: ctx.publishableKey,
      password: ctx.password,
      tenantId: DEV_TENANT_ID,
      firmCompanyId,
      address,
      owner: { id: owner.id as string, email },
    });
    console.log(`Gmail mailbox ${address} -> ${email} (source ${placement})`);
  }

  // The demo loads a stored, audited policy, as live Gmail must (#263). The Graph path and the base replay seed
  // none (#263 R9): with no row, fixture mode serves version 0. main's preflight already refused a hosted URL and a
  // foreign policy; ensureDemoExclusionPolicy re-checks both, and the RPC's expected_version catches a race.
  if (ctx.selection.corpus === 'demo') {
    if (!ctx.demoRules) throw new Error('the demo replay needs the rules main read in its preflight');
    const policy = await ensureDemoExclusionPolicy(db, DEV_TENANT_ID, ctx.demoRules);
    console.log(`Exclusion policy v${policy.version} (${policy.written ? 'written' : 'unchanged'}).`);
  }

  if (ctx.team) await seedTeamInbox({ db, url: ctx.url, publishableKey: ctx.publishableKey, password: ctx.password, dir, team: ctx.team });

  await classifyAndReport(db, READER_MODE.FIXTURE);
}

/**
 * `--team-inbox`: the team inbox as its admin registers it (#581). The connect RPC runs under the seeded firm admin's
 * own session (it acts on auth.uid() and is not callable by the service role), the Directory check is recorded as the
 * worker records it (service role, through the same RPC, with the id the fixture check gives), and each member is added
 * under the admin's session too. Idempotent: connect returns the open registration, a repeated check and a repeated add
 * change nothing. The first classify pass then reads the inbox, since its check is fresh.
 */
async function seedTeamInbox(args: {
  db: SupabaseClient;
  url: string;
  publishableKey: string;
  password: string;
  dir: string;
  team: TeamInboxSelection;
}): Promise<void> {
  const { db, team } = args;
  if (!replayMailboxes(args.dir).includes(team.address)) {
    throw new Error(`${args.dir} holds no replay for ${team.address}: run npm run discovery:build-demo-twin`);
  }
  const adminEmail = seedEmail('admin');
  const session = createClient(args.url, args.publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const signIn = await session.auth.signInWithPassword({ email: adminEmail, password: args.password });
  if (signIn.error) throw new Error(`Seed user ${adminEmail} could not sign in: ${signIn.error.message}`);
  try {
    const connected = await session.rpc('discovery_connect_team_mailbox', {
      p_address: team.address,
      p_attestation_version: TEAM_MAILBOX_ATTESTATION_VERSION,
      p_backfill_since: null,
    });
    if (connected.error) {
      const hint = connected.error.message.includes('provider_unresolved')
        ? ' (the address must resolve to the Google registration alone: seed a stack with --google-replay only, no Graph registration)'
        : '';
      throw new Error(`Connecting the team inbox failed: ${connected.error.message}${hint}`);
    }
    const teamMailboxId = (connected.data as { teamMailbox: { id: string } }).teamMailbox.id;
    const checked = await db.rpc('discovery_record_team_mailbox_check', {
      p_id: teamMailboxId,
      p_status: 'verified',
      p_reason: null,
      p_directory_user_id: fixtureDirectoryUserId(team.address),
    });
    if (checked.error) throw new Error(`Recording the team inbox check failed: ${checked.error.message}`);
    console.log(`Team inbox ${team.address} connected and verified.`);

    for (const name of team.memberNames) {
      const owner = FIXTURE_MAILBOX_OWNERS.find((o) => personaName(o.address) === name);
      if (!owner) throw new Error(`--team-members names ${name}, not a demo persona`);
      const email = seedEmail(owner.ownerSlug);
      const { data: user, error: userError } = await db.from(TABLE.USERS).select('id').eq('email', email).maybeSingle();
      if (userError) throw userError;
      if (!user) throw new Error(`Seed user ${email} is missing. Run seed:users first.`);
      const added = await session.rpc('discovery_add_team_mailbox_member', { p_id: teamMailboxId, p_user: user.id });
      if (added.error) throw new Error(`Adding ${email} to the team inbox failed: ${added.error.message}`);
      console.log(`Team inbox ${team.address}: ${email} is a member.`);
    }
  } finally {
    await session.auth.signOut();
  }
}

async function classifyAndReport(db: SupabaseClient, mode: typeof READER_MODE.FIXTURE): Promise<void> {
  const summary = await runOnce({ tenantId: DEV_TENANT_ID, db, provider: mode });
  if (summary.status !== 'ok') {
    const hint = summary.reason === 'flag_disabled' ? ' (the worker reads nothing while deal_discovery is off; run npm run seed:flags:enable)' : '';
    throw new Error(`Classification skipped: ${summary.reason}${hint}`);
  }
  const created = summary.candidates.filter((c) => c.created).length;
  console.log(
    `Classified ${summary.itemsRead} items, stored ${summary.itemsStored}, ` +
      `${summary.candidates.length} candidates (${created} new).`,
  );
}

async function main(argv: string[]): Promise<void> {
  const selection = selectCorpus(argv); // before any database work: a bad flag fails fast
  const team = selectTeamInbox(argv, selection);
  const personas = selectPersonas(argv);
  if (personas && !argv.includes('--google-replay')) throw new Error('--personas needs --google-replay');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set (see .env.example)');
  }
  if (process.env.NEXT_PUBLIC_APP_ENV === 'prod') {
    throw new Error('Refusing to seed synthetic mail into prod');
  }
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const password = process.env.SEED_PASSWORD;
  if (!publishableKey || !password) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and SEED_PASSWORD must be set: each owner opts in under their own session',
    );
  }
  const createDb = () => createClient(url, key, { auth: { persistSession: false } });
  // --google-replay --corpus demo writes an append-only policy row later: refuse a hosted URL before the client
  // exists, an invalid rules file and a policy someone else wrote before any write (round 2, R1). --google wins over
  // --google-replay (below), so the preflight runs only when the demo replay is what will run.
  const { db, demoRules } = await openSeedDb({ argv, env: process.env, selection, tenantId: DEV_TENANT_ID, createDb });

  const googleAt = argv.indexOf('--google');
  if (googleAt !== -1) {
    const file = argv[googleAt + 1];
    if (!file || file.startsWith('--')) throw new Error('--google needs a registration file (.secrets/google/registration.json)');
    await seedGoogle(file, { db, url, publishableKey, password });
    return;
  }

  // The registration names the bank's own firm: the company the first fixture
  // owner (md) is seated in. All three owners must share it, so a second bank
  // in the tenant (Northwind) is never named.
  const firmCompanyId = await firmCompanyOf(db, FIXTURE_MAILBOX_OWNERS.map((o) => o.ownerSlug));

  if (argv.includes('--google-replay')) {
    await seedGoogleReplay(argv, { db, url, publishableKey, password, firmCompanyId, selection, demoRules, personas, team });
    return;
  }

  const { error: registrationError } = await db.from(TABLE.GRAPH_READER_REGISTRATIONS).upsert(
    {
      tenant_id: DEV_TENANT_ID,
      ms_tenant_id: 'fixture',
      client_id: 'fixture',
      status: REGISTRATION_STATUS.ACTIVE,
      mailbox_domains: ['bank.example'],
      firm_company_id: firmCompanyId,
    },
    { onConflict: 'tenant_id' },
  );
  if (registrationError) throw registrationError;

  for (const { address, ownerSlug } of FIXTURE_MAILBOX_OWNERS) {
    const email = seedEmail(ownerSlug);
    const { data: owner, error: ownerError } = await db
      .from(TABLE.USERS)
      .select('id')
      .eq('email', email)
      .maybeSingle();
    if (ownerError) throw ownerError;
    if (!owner) throw new Error(`Seed user ${email} is missing. Run seed:users first.`);

    // Explicit provider, so a run after --google-replay switches the source back (archiving what it read).
    const placement = await placeMailboxSource(db, {
      tenantId: DEV_TENANT_ID,
      address,
      ownerId: owner.id as string,
      provider: MAILBOX_PROVIDER.MICROSOFT,
    });

    await ensureInviteAndConsent({
      db,
      url,
      publishableKey,
      password,
      tenantId: DEV_TENANT_ID,
      firmCompanyId,
      address,
      owner: { id: owner.id as string, email },
    });
    console.log(`Mailbox ${address} -> ${email} (source ${placement})`);
  }

  await classifyAndReport(db, READER_MODE.FIXTURE);
}

if (process.argv[1]?.endsWith('seed-discovery.ts')) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
