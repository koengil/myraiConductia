import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/*
 * #490: Google ends a banker's sending approval, against a REAL database.
 *
 *   seeded Google row -> POST /api/v1/outbox -> the token endpoint answers 400 invalid_grant
 *     -> 502 with the reconnect copy, the pending row deleted, the row revoked with its token
 *        deleted, and a mailbox.approval_ended audit row
 *   -> the next send is refused before the screen, with no Google call
 *   -> DELETE /api/v1/mailbox -> mailbox.disconnected -> the next send leaves through the
 *      platform transport (noop)
 *
 * What is real: the route handlers, the admin client, Postgres (the mailbox_connections
 * status/token CHECK, the audit chain), the rules screen and the token encryption. What is
 * faked: the browser session (as in deal-list-scale.test.ts), and Google, through a
 * URL-routed fetch that passes every other request (Supabase) to the real fetch. Nothing in
 * src/ can create a Google row before the callback ships (S3a), so the row is seeded.
 */

const session = { id: '', email: '' };

vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/server')>();
  return {
    ...actual,
    createSupabaseServerClient: async () => ({
      auth: {
        getUser: async () => ({ data: { user: { id: session.id, email: session.email } }, error: null }),
        mfa: {
          getAuthenticatorAssuranceLevel: async () => ({
            data: { currentLevel: 'aal2', nextLevel: 'aal2' },
            error: null,
          }),
        },
      },
    }),
  };
});

import { createClient } from '@supabase/supabase-js';
import { DELETE as disconnect } from '@/app/api/v1/mailbox/route';
import { POST as send } from '@/app/api/v1/outbox/route';
import { createProvisionedUser } from '@/lib/auth/provisioning';
import { GMAIL_RECONNECT_COPY } from '@/lib/constants/mailboxSend';
import { encryptTokens } from '@/lib/email/tokenCrypto';
import { fakeGmailSend, invalidGrant } from '../helpers/fakeGmailSend';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  throw new Error('The Gmail revoked-path test needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (local `supabase start` stack).');
}
// It seeds a user and toggles mail_channel with the service role: a local stack only.
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
  throw new Error('The Gmail revoked-path test runs against a local Supabase only (127.0.0.1 or localhost).');
}
const db = createClient(url, secret, { auth: { persistSession: false } });

const RUN = Date.now().toString(36);
const TENANT = crypto.randomUUID();
const md = { id: '', email: `gmail-revoked-${RUN}@integration.conductia.dev` };

const realFetch = globalThis.fetch;
const gmail = fakeGmailSend({ token: invalidGrant, other: (input, init) => realFetch(input, init) });

const draft = { to: ['founder@target.example'], subject: 'Process update', body: 'The room opens Monday.' };
const post = () => send(new Request('http://localhost/api/v1/outbox', { method: 'POST', body: JSON.stringify(draft) }));

async function auditRows(action: string): Promise<Array<{ detail: unknown }>> {
  const { data, error } = await db.from('audit_log').select('detail').eq('actor_id', md.id).eq('action', action);
  if (error) throw new Error(`audit read failed: ${error.message}`);
  return data ?? [];
}

async function outboxRows(): Promise<Array<{ status: string; provider: string | null }>> {
  const { data, error } = await db.from('outbound_messages').select('status, provider').eq('sender_id', md.id);
  if (error) throw new Error(`outbox read failed: ${error.message}`);
  return data ?? [];
}

let previousFlag: { enabled: boolean } | null = null;

beforeAll(async () => {
  vi.stubEnv('GOOGLE_SEND_CLIENT_ID', 'integration-send-client');
  vi.stubEnv('GOOGLE_SEND_CLIENT_SECRET', 'integration-send-secret');
  vi.stubEnv('GOOGLE_SEND_REDIRECT_URI', 'http://localhost:3000/api/v1/mailbox/google/callback');
  vi.stubEnv('MAILBOX_TOKEN_KEY', 'c'.repeat(64));
  vi.stubEnv('OUTBOX_SCREEN_SECRET', 'integration-screen-secret');
  vi.stubEnv('AI_GATEWAY_API_KEY', '');
  vi.stubEnv('MS_CLIENT_ID', '');
  vi.stubEnv('EMAIL_PROVIDER', 'noop');
  vi.stubEnv('EMAIL_FROM', 'Conductia <deals@integration.conductia.dev>');

  const { data } = await db.from('feature_flags').select('enabled').eq('key', 'mail_channel').maybeSingle();
  previousFlag = data as { enabled: boolean } | null;
  const { error: flagError } = await db
    .from('feature_flags')
    .upsert({ key: 'mail_channel', description: 'mail channel (integration)', enabled: true }, { onConflict: 'key' });
  if (flagError) throw new Error(`flag upsert failed: ${flagError.message}`);

  const user = await createProvisionedUser(db, {
    email: md.email,
    password: `Integration-${RUN}-x9!`,
    email_confirm: true,
    profile: { tenant_id: TENANT },
  });
  md.id = user.id;
  session.id = md.id;
  session.email = md.email;

  const { error: seedError } = await db.from('mailbox_connections').insert({
    user_id: md.id,
    provider: 'google',
    email: md.email,
    tokens_encrypted: encryptTokens({ refreshToken: `rt-integration-${RUN}` }),
    scopes: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email openid',
    account_sub: `sub-${RUN}`,
    status: 'connected',
  });
  if (seedError) throw new Error(`mailbox seed failed: ${seedError.message}`);

  vi.stubGlobal('fetch', gmail.fetch);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  // KNOWN RESIDUE, as in deal-list-scale.test.ts: the audit rows this run writes are immutable
  // and name the user, so the user is suspended rather than deleted. The CI stack is destroyed whole.
  if (md.id) {
    await db.from('outbound_messages').delete().eq('sender_id', md.id);
    await db.from('mailbox_connections').delete().eq('user_id', md.id);
    await db.from('users').delete().eq('id', md.id);
    await db.auth.admin.deleteUser(md.id);
    const { data: left } = await db.from('users').select('id').eq('id', md.id).maybeSingle();
    if (left) await db.from('users').update({ status: 'suspended' }).eq('id', md.id);
  }
  if (previousFlag) await db.from('feature_flags').update({ enabled: previousFlag.enabled }).eq('key', 'mail_channel');
  else await db.from('feature_flags').delete().eq('key', 'mail_channel');
  vi.unstubAllEnvs();
});

describe('Gmail send: Google ends the approval (#490)', () => {
  it('fails the send with the reconnect copy, revokes the row and audits approval_ended', async () => {
    const res = await post();

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe(`Email provider send failed: ${GMAIL_RECONNECT_COPY}`);
    expect(gmail.log).toEqual(['token']);
    // The screen ran first and is on record; the pending row was deleted, nothing was sent.
    expect(await auditRows('screen')).toHaveLength(1);
    expect(await outboxRows()).toEqual([]);

    const { data: row, error } = await db
      .from('mailbox_connections')
      .select('status, tokens_encrypted, revoked_at')
      .eq('user_id', md.id)
      .single();
    expect(error).toBeNull();
    expect(row).toMatchObject({ status: 'revoked', tokens_encrypted: null });
    expect(row?.revoked_at).toEqual(expect.any(String));
    expect(await auditRows('mailbox.approval_ended')).toEqual([{ detail: { provider: 'google' } }]);
  });

  it('refuses the next send before the screen, with no Google call', async () => {
    gmail.reset();
    const res = await post();

    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe(`Email provider send failed: ${GMAIL_RECONNECT_COPY}`);
    expect(gmail.log).toEqual([]);
    expect(await auditRows('screen')).toHaveLength(1);
    expect(await outboxRows()).toEqual([]);
  });

  it('disconnects with an audit row; the next send leaves through the platform transport', async () => {
    gmail.reset();
    const res = await disconnect();
    expect(res.status).toBe(204);
    const { data: left } = await db.from('mailbox_connections').select('id').eq('user_id', md.id);
    expect(left).toEqual([]);
    expect(await auditRows('mailbox.disconnected')).toEqual([{ detail: { provider: 'google' } }]);

    const sent = await post();
    expect(sent.status).toBe(201);
    expect((await sent.json()).message).toMatchObject({ status: 'sent', provider: 'noop' });
    expect(gmail.log).toEqual([]);
    expect(await outboxRows()).toEqual([{ status: 'sent', provider: 'noop' }]);
  });
});
