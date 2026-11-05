import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SKIP_APPROVER_DEAL_ROLES } from '@/lib/constants/dealSteps';

/*
 * #312: the SQL rule for who may approve a step skip (rail_skip_approver) and the
 * TypeScript rule (SKIP_APPROVER_DEAL_ROLES, which resolveSkipApprover and the Skip
 * modal read) are two copies of one decision. This pins them together: the role
 * list in the newest migration that declares the helper must equal the constant,
 * so adding or removing a role in one place without the other fails here.
 */

const MIGRATIONS = join(process.cwd(), 'supabase/migrations');

function quotedValues(fragment: string): string[] {
  return [...fragment.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

/** The newest migration's text (comments removed) that declares the helper, or null. */
function latestHelperMigration(): { file: string; sql: string } | null {
  const declared = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(MIGRATIONS, file), 'utf8').replace(/--.*$/gm, '') }))
    .filter(({ sql }) => /create or replace function rail_skip_approver\(/.test(sql));
  return declared.at(-1) ?? null;
}

describe('rail_skip_approver mirrors the skip approver roles', () => {
  it('is declared in a migration, as an invoker with a pinned search path and no grant', () => {
    const latest = latestHelperMigration();
    expect(latest, 'rail_skip_approver not found in migrations').not.toBeNull();
    const body = /create or replace function rail_skip_approver\([\s\S]*?\n\$\$;/.exec(latest?.sql ?? '')?.[0] ?? '';
    expect(body, 'rail_skip_approver body not found (it must end with $$;)').not.toBe('');
    expect(body).toMatch(/security invoker/);
    expect(body).toMatch(/set search_path = public, pg_temp/);
    expect(latest?.sql).toMatch(
      /revoke all on function rail_skip_approver\(uuid, uuid\) from public, anon, authenticated, service_role/,
    );
    expect(latest?.sql).not.toMatch(/grant\s+execute\s+on\s+function\s+rail_skip_approver/i);
  });

  it('lists the same deal roles as SKIP_APPROVER_DEAL_ROLES', () => {
    const latest = latestHelperMigration();
    expect(latest, 'rail_skip_approver not found in migrations').not.toBeNull();
    const body = /create or replace function rail_skip_approver\([\s\S]*?\n\$\$;/.exec(latest?.sql ?? '')?.[0] ?? '';
    expect(body, 'rail_skip_approver body not found (it must end with $$;)').not.toBe('');
    const list = /deal_role in \(([^)]*)\)/.exec(body);
    expect(list, 'rail_skip_approver has no deal_role in (...) list').not.toBeNull();
    expect(quotedValues(list?.[1] ?? '').sort()).toEqual([...SKIP_APPROVER_DEAL_ROLES].sort());
  });

  it('takes the user row lock before the seat lock', () => {
    const body =
      /create or replace function rail_skip_approver\([\s\S]*?\n\$\$;/.exec(latestHelperMigration()?.sql ?? '')?.[0] ?? '';
    const user = body.search(/from users u[\s\S]*?for share/);
    const seat = body.search(/from deal_memberships m[\s\S]*?for share/);
    expect(user, 'the user row read is missing').toBeGreaterThanOrEqual(0);
    expect(seat, 'the seat read is missing').toBeGreaterThanOrEqual(0);
    expect(user).toBeLessThan(seat);
  });
});
