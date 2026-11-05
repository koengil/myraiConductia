import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';

import { applyGoogleRegistration, parseGoogleRegistrationConfig, registrationDbFor } from '../../scripts/google/write-registration';
import { placeMailboxSource } from '../../scripts/seed-discovery';

/*
 * The operator tooling's side of #262's source lifecycle (#259), against a REAL database. An orphaned mailbox
 * source is archived with its history (renamed <address>~xyz, paused, ownerless, stamped), so:
 *
 *   - scripts/google/write-registration.ts never matches, renames, resumes, re-owns or pauses an archived row, and
 *     with no `sources` key it touches no source at all;
 *   - scripts/seed-discovery.ts (placeMailboxSource, the `--google-replay` move) creates a source for an address
 *     that has none, flips an unused source's provider in place and clears its sync state, and archives a source
 *     that holds the other provider's items instead of re-providering it. An archived row is never written.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) throw new Error('needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (local stack)');
const db = createClient(url, secret, { auth: { persistSession: false } });

const RUN = Date.now().toString(36);
const TENANT = crypto.randomUUID();
let bankId = '';
let ownerId = '';
const OWNER_EMAIL = `gl-owner-${RUN}@integration.conductia.dev`;
const ARCHIVED_AT = '2026-10-01T10:00:00Z';

function googleConfig(sources?: Array<{ address: string; ownerEmail: string }>) {
  const parsed = parseGoogleRegistrationConfig({
    tenantId: TENANT,
    workspaceDomain: 'bank.example',
    serviceAccountEmail: 'dwd-reader@proj-1.iam.gserviceaccount.com',
    clientId: '123456789012345678',
    directoryServiceAccountEmail: 'dir-reader@proj-1.iam.gserviceaccount.com',
    allowlistGroup: 'conductia-ingest@bank.example',
    firmCompanyId: bankId,
    status: 'pending',
    ...(sources ? { sources } : {}),
  });
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.config;
}

async function sources() {
  const { data, error } = await db
    .from('content_sources')
    .select('id, address, provider, status, owner_user_id, archived_at, archived_from_address, delta_checkpoint')
    .eq('tenant_id', TENANT)
    .order('address');
  if (error) throw error;
  return data ?? [];
}

/** What #262's archive leaves behind: renamed, paused, ownerless, stamped, with its history. */
async function archive(id: string, address: string): Promise<string> {
  const archivedAddress = `${address}~k3x`;
  const { error } = await db
    .from('content_sources')
    .update({ address: archivedAddress, status: 'paused', owner_user_id: null, archived_at: ARCHIVED_AT, archived_from_address: address })
    .eq('id', id);
  if (error) throw error;
  return archivedAddress;
}

async function attachItem(sourceId: string, key: string): Promise<void> {
  const item = await db
    .from('source_items')
    .insert({ tenant_id: TENANT, kind: 'message', internet_message_id: `<${key}-${RUN}@x>`, content_hash: `hash-${key}` })
    .select('id')
    .single();
  if (item.error) throw item.error;
  const link = await db.from('source_item_sources').insert({ source_item_id: item.data.id, content_source_id: sourceId, provider_item_id: key });
  if (link.error) throw link.error;
}

beforeAll(async () => {
  const company = await db.from('companies').insert({ tenant_id: TENANT, name: `GL Bank ${RUN}`, type: 'bank' }).select('id').single();
  if (company.error) throw new Error(`company failed: ${company.error.message}`);
  bankId = company.data.id as string;
  const user = await db.auth.admin.createUser({
    email: OWNER_EMAIL,
    password: `Gl-${RUN}-x9!`,
    email_confirm: true,
    user_metadata: { tenant_id: TENANT, department: 'ib' },
  });
  if (user.error || !user.data.user) throw new Error(`user failed: ${user.error?.message}`);
  ownerId = user.data.user.id;
  await db.from('users').update({ tenant_id: TENANT, status: 'active', is_external: false }).eq('id', ownerId);
  // Both providers are registered, as in the dev tenant, so a source can sit on either.
  const graph = await db.from('graph_reader_registrations').insert({
    tenant_id: TENANT,
    ms_tenant_id: 'fixture',
    client_id: 'fixture',
    status: 'active',
    mailbox_domains: ['bank.example'],
    firm_company_id: bankId,
  });
  if (graph.error) throw graph.error;
  await applyGoogleRegistration(registrationDbFor(db), googleConfig());
});

afterAll(async () => {
  await db.from('source_items').delete().eq('tenant_id', TENANT);
  await db.from('content_sources').delete().eq('tenant_id', TENANT);
  await db.from('google_reader_registrations').delete().eq('tenant_id', TENANT);
  await db.from('graph_reader_registrations').delete().eq('tenant_id', TENANT);
  if (ownerId) await db.auth.admin.deleteUser(ownerId);
  if (bankId) await db.from('companies').delete().eq('id', bankId);
});

describe('write-registration against an archived Google source', () => {
  it('with no sources key writes the registration and touches no source', async () => {
    const live = await db.from('content_sources').insert({ tenant_id: TENANT, kind: 'mailbox', provider: 'google', address: 'member@bank.example', owner_user_id: ownerId, status: 'active' }).select('id').single();
    if (live.error) throw live.error;
    const result = await applyGoogleRegistration(registrationDbFor(db), googleConfig());
    expect(result.sources).toEqual([]);
    expect((await sources()).map((s) => [s.address, s.status])).toEqual([['member@bank.example', 'active']]);
    await db.from('content_sources').delete().eq('id', live.data.id);
  });

  it('never matches, renames, resumes, re-owns or pauses an archived row, and creates a fresh source for the address', async () => {
    const old = await db.from('content_sources').insert({ tenant_id: TENANT, kind: 'mailbox', provider: 'google', address: 'storm@bank.example', owner_user_id: ownerId, status: 'active' }).select('id').single();
    if (old.error) throw old.error;
    await attachItem(old.data.id as string, 'g-storm');
    const archivedAddress = await archive(old.data.id as string, 'storm@bank.example');
    // A second archived Google row that is (wrongly) still active, and not in the list: it must not be "paused" either.
    const stray = await db.from('content_sources').insert({ tenant_id: TENANT, kind: 'mailbox', provider: 'google', address: 'stray@bank.example', status: 'active' }).select('id').single();
    if (stray.error) throw stray.error;
    const strayAddress = `stray@bank.example~a1b`;
    await db.from('content_sources').update({ address: strayAddress, archived_at: ARCHIVED_AT, archived_from_address: 'stray@bank.example' }).eq('id', stray.data.id);

    const result = await applyGoogleRegistration(
      registrationDbFor(db),
      googleConfig([{ address: 'storm@bank.example', ownerEmail: OWNER_EMAIL }]),
    );
    expect(result.sources).toEqual([{ address: 'storm@bank.example', action: 'insert' }]);

    const rows = await sources();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(old.data.id as string)).toMatchObject({
      address: archivedAddress,
      status: 'paused',
      owner_user_id: null,
      archived_at: expect.any(String),
      archived_from_address: 'storm@bank.example',
    });
    expect(byId.get(stray.data.id as string)).toMatchObject({ address: strayAddress, status: 'active', archived_at: expect.any(String) });
    const fresh = rows.find((r) => r.address === 'storm@bank.example');
    expect(fresh).toMatchObject({ provider: 'google', status: 'active', owner_user_id: ownerId, archived_at: null });
    expect(fresh!.id).not.toBe(old.data.id);

    // A re-run updates the live source and still leaves the archive alone.
    const again = await applyGoogleRegistration(
      registrationDbFor(db),
      googleConfig([{ address: 'storm@bank.example', ownerEmail: OWNER_EMAIL }]),
    );
    expect(again.sources).toEqual([{ address: 'storm@bank.example', action: 'update' }]);
    expect((await sources()).filter((r) => r.archived_at).map((r) => [r.address, r.status, r.owner_user_id])).toEqual([
      [archivedAddress, 'paused', null],
      [strayAddress, 'active', null],
    ]);
  });

  it('the database itself refuses a late sync write to an archived source (source_archived)', async () => {
    const archived = (await sources()).find((r) => r.archived_at && r.address.startsWith('storm@'));
    const { error } = await db.from('content_sources').update({ delta_checkpoint: 'late' }).eq('id', archived!.id);
    expect(error?.message).toBe('source_archived');
  });
});

describe('seed-discovery placeMailboxSource (the --google-replay move)', () => {
  it('creates a source for an address that has none', async () => {
    expect(await placeMailboxSource(db, { tenantId: TENANT, address: 'alex@bank.example', ownerId, provider: 'google' })).toBe('created');
    expect((await sources()).find((r) => r.address === 'alex@bank.example')).toMatchObject({ provider: 'google', owner_user_id: ownerId, status: 'active' });
  });

  it('is idempotent for the same provider and keeps the checkpoint', async () => {
    await db.from('content_sources').update({ delta_checkpoint: 'kept' }).eq('tenant_id', TENANT).eq('address', 'alex@bank.example');
    expect(await placeMailboxSource(db, { tenantId: TENANT, address: 'ALEX@bank.example', ownerId, provider: 'google' })).toBe('updated');
    expect((await sources()).find((r) => r.address === 'alex@bank.example')).toMatchObject({ delta_checkpoint: 'kept' });
  });

  it('flips an unused source to the other provider in place, clearing its sync state', async () => {
    expect(await placeMailboxSource(db, { tenantId: TENANT, address: 'alex@bank.example', ownerId, provider: 'microsoft' })).toBe('flipped');
    expect((await sources()).filter((r) => r.address === 'alex@bank.example')).toEqual([
      expect.objectContaining({ provider: 'microsoft', status: 'active', owner_user_id: ownerId, delta_checkpoint: null, archived_at: null }),
    ]);
  });

  it('archives a source that holds the other provider’s items instead of re-providering it, and creates a fresh one', async () => {
    const before = (await sources()).find((r) => r.address === 'alex@bank.example')!;
    await attachItem(before.id as string, 'ms-alex');
    expect(await placeMailboxSource(db, { tenantId: TENANT, address: 'alex@bank.example', ownerId, provider: 'google' })).toBe('archived_and_created');

    const rows = await sources();
    const old = rows.find((r) => r.id === before.id)!;
    expect(old).toMatchObject({ provider: 'microsoft', status: 'paused', owner_user_id: null, archived_from_address: 'alex@bank.example' });
    expect(old.archived_at).not.toBeNull();
    expect(old.address).toMatch(/^alex@bank\.example~[a-z0-9]{3}$/);
    const fresh = rows.find((r) => r.address === 'alex@bank.example')!;
    expect(fresh).toMatchObject({ provider: 'google', status: 'active', owner_user_id: ownerId, archived_at: null, delta_checkpoint: null });
    // The history stays with the archived source, none of it on the fresh one.
    const links = await db.from('source_item_sources').select('content_source_id').eq('content_source_id', fresh.id);
    expect(links.data).toEqual([]);
  });

  it('never writes an archived row: a second move leaves earlier archives exactly as they were', async () => {
    const archivedBefore = (await sources()).filter((r) => r.archived_at);
    expect(archivedBefore.length).toBeGreaterThan(0);
    expect(await placeMailboxSource(db, { tenantId: TENANT, address: 'alex@bank.example', ownerId, provider: 'google' })).toBe('updated');
    expect((await sources()).filter((r) => r.archived_at)).toEqual(archivedBefore);
  });
});
