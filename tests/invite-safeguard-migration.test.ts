import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INVITE_CHALLENGE_MAX_ATTEMPTS,
  INVITE_DOMAIN_CONFIRMATION_CLASSIFICATIONS,
  INVITE_DOMAIN_CONFIRMATION_TTL_MINUTES,
} from '@/lib/constants/invites';

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260804160000_invite_safeguard_2fa.sql'),
  'utf8',
);
const existingAccountGrantMigration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260812120000_existing_account_deal_grant.sql'),
  'utf8',
);

describe('invite safeguard migration contract', () => {
  it('stores only keyed challenge digests and binds verification to a version and user', () => {
    expect(migration).toContain('challenge_digest text');
    expect(migration).toContain("challenge_digest ~ '^[0-9a-f]{64}$'");
    expect(migration).toContain('challenge_verified_user_id uuid');
    expect(migration).toContain('challenge_verified_version integer');
    expect(migration).toContain('constant_work_digest_equal');
    expect(migration).not.toMatch(/challenge_(?:code|plaintext)\s+text/i);
  });

  it('mirrors confirmation classifications, TTL, and attempt ceiling', () => {
    for (const classification of INVITE_DOMAIN_CONFIRMATION_CLASSIFICATIONS) {
      expect(migration).toContain(`'${classification}'`);
    }
    expect(migration).toContain(`interval '${INVITE_DOMAIN_CONFIRMATION_TTL_MINUTES} minutes'`);
    expect(migration).toContain(`challenge_attempts between 0 and ${INVITE_CHALLENGE_MAX_ATTEMPTS}`);
  });

  it('removes historical RPC overloads that could bypass challenge inputs', () => {
    expect(migration).toContain('drop function public.create_invite(uuid, text, uuid, text, uuid, text)');
    expect(migration).toContain('drop function public.rotate_invite_credential(uuid)');
  });

  it('keeps trusted domains and confirmations server-only behind RLS', () => {
    expect(migration).toContain('alter table company_verified_domains enable row level security');
    expect(migration).toContain('alter table invite_domain_confirmations enable row level security');
    expect(migration).toContain('revoke all on company_verified_domains from anon, authenticated');
    expect(migration).toContain('revoke all on invite_domain_confirmations from anon, authenticated');
  });

  it('refuses an ambiguous case-insensitive active-account match', () => {
    expect(existingAccountGrantMigration).toContain('select count(*) into v_target_count');
    expect(existingAccountGrantMigration).toContain('if v_target_count <> 1 then');
    expect(existingAccountGrantMigration).toContain('select * into strict v_target');
  });
});
