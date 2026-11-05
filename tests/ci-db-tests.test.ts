// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Pins the CI database gate (#262, C18). The `tests/db/*` wrappers skip unless
 * RUN_DB_TESTS=1, and CI lists the wrappers it runs by hand. A wrapper that is
 * not on the list never runs there: the mailbox concurrency case (a second
 * session meeting the seat lock between committed transactions) cannot run
 * under the psql probe, which rolls back, so it lived in a file CI skipped.
 *
 * This reads .github/workflows/ci.yml as text. It is not a YAML parser; it
 * only needs the `RUN_DB_TESTS=1 ... vitest run` command and the gated steps.
 */

const CI = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

/** Files named by the `RUN_DB_TESTS=1 ... npx vitest run a b c` command, joined across `\` continuations. */
export function dbVitestList(ci: string): string[] {
  const joined = ci.replace(/\\\r?\n/g, ' ');
  const line = joined.split('\n').find((l) => /RUN_DB_TESTS=1\b/.test(l) && /vitest\s+run\b/.test(l));
  if (!line) return [];
  return line
    .slice(line.indexOf('vitest run') + 'vitest run'.length)
    .split(/\s+/)
    .filter((t) => t.startsWith('tests/'));
}

/** The text of the step whose `name:` is exactly this, up to the next step or job. */
export function stepText(ci: string, name: string): string {
  const start = ci.indexOf(`- name: ${name}`);
  if (start < 0) return '';
  const rest = ci.slice(start + 1);
  const next = rest.search(/\n {6}- name: |\n {2}[a-z0-9_-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('CI runs the mailbox database tests (C18)', () => {
  const list = dbVitestList(CI);

  it('reads the RUN_DB_TESTS=1 list', () => {
    expect(list.length).toBeGreaterThan(5);
  });

  // reader-pass-concurrency is the only test of the reader pass writer's tenant lock (#370, R2-M3): it needs two
  // committed transactions, which the rolled-back psql probe cannot give.
  it.each(['tests/db/mailbox-allowlist.test.ts', 'tests/db/discovery-rls.test.ts', 'tests/db/reader-pass-concurrency.test.ts', 'tests/db/send-census-concurrency.test.ts'])('lists %s', (file) => {
    expect(list).toContain(file);
  });

  // The whole list, pinned: dropping any wrapper from ci.yml (or adding one without listing it here) fails this.
  it('runs exactly the expected wrappers', () => {
    expect([...list].sort()).toEqual(
      [
        'tests/db/rls-deal-scoped-policies.test.ts',
        'tests/db/audit-log-immutability.test.ts',
        'tests/db/client-company-access-management.test.ts',
        'tests/db/client-company-default-roles.test.ts',
        'tests/db/company-access-management.test.ts',
        'tests/db/invite-safeguards.test.ts',
        'tests/db/legal-hold.test.ts',
        'tests/db/project-rail.test.ts',
        'tests/db/mailbox-allowlist.test.ts',
        'tests/db/discovery-rls.test.ts',
        'tests/db/discovery-purge.test.ts',
        'tests/db/discovery-tenant-purge.test.ts',
        'tests/db/work-identity-onboarding.test.ts',
        'tests/db/invite-authority-parity.test.ts',
        'tests/db/invite-authority-concurrency.test.ts',
        'tests/db/template-change-review.test.ts',
        'tests/db/team-mailbox-lock-order.test.ts',
        'tests/db/reader-pass-concurrency.test.ts',
        'tests/db/send-census-concurrency.test.ts',
      ].sort(),
    );
  });

  it('lists only wrappers that exist, each once', () => {
    for (const file of list) expect(existsSync(join(process.cwd(), file)), file).toBe(true);
    expect(new Set(list).size).toBe(list.length);
  });

  it('keeps the SQL probes inside the gated integration step, including the mailbox suite', () => {
    const step = stepText(CI, 'Run the integration suite');
    expect(step).toContain("if: steps.gate.outputs.run == 'true'");
    for (const suite of ['mailbox_allowlist', 'team_mailboxes', 'team_mailbox_audit', 'discovery_rls', 'discovery_health', 'definer_grants', 'rail_templates', 'rail_catalog_publish', 'rail_catalog_save', 'ai_budget_alerts', 'deal_steps', 'deal_gate0_lifecycle', 'deal_step_skill_runs', 'notifications', 'setup_walkthroughs', 'wall_breach', 'send_census']) {
      expect(step, suite).toContain(`-f supabase/tests/${suite}.sql`);
    }
  });

  // #461: the purge probe runs in CI; the timing probe seeds pilot-scale rows and is a local measurement only.
  it('runs the purge probe and keeps the timing probe out of CI', () => {
    expect(list).toContain('tests/db/discovery-purge.test.ts');
    expect(stepText(CI, 'Run the integration suite')).toContain('-f supabase/tests/discovery_purge.sql');
    expect(CI).not.toContain('discovery_purge_timing');
    expect(existsSync(join(process.cwd(), 'supabase/tests/discovery_purge_timing.sql'))).toBe(true);
  });

  // #461 slice 3: the tenant purge probe runs in CI, as a wrapper and as a bare psql run.
  it('runs the tenant purge probe', () => {
    expect(list).toContain('tests/db/discovery-tenant-purge.test.ts');
    expect(stepText(CI, 'Run the integration suite')).toContain('-f supabase/tests/discovery_tenant_purge.sql');
  });

  it('gates the vitest list step on the same condition', () => {
    const step = stepText(CI, 'DB probes (tests/db)');
    expect(step).toContain("if: steps.gate.outputs.run == 'true'");
  });

  it('runs the wrappers one file at a time, since two probes take DDL locks that deadlock in parallel', () => {
    const step = stepText(CI, 'DB probes (tests/db)');
    expect(step).toMatch(/RUN_DB_TESTS=1\b.*vitest run --no-file-parallelism\b/);
  });
});

describe('CI runs the invite authority parity probes (#296)', () => {
  const list = dbVitestList(CI);

  it.each(['tests/db/invite-authority-parity.test.ts', 'tests/db/invite-authority-concurrency.test.ts'])(
    'lists %s',
    (file) => {
      expect(list).toContain(file);
    },
  );

  it.each(['invite_authority_parity', 'invite_authority_backfill', 'invite_tenant_crossing'])(
    'runs supabase/tests/%s.sql in the gated integration step',
    (suite) => {
      const step = stepText(CI, 'Run the integration suite');
      expect(step).toContain(`-f supabase/tests/${suite}.sql`);
    },
  );

  it('runs company-access-management too, now that the write grants are revoked', () => {
    expect(list).toContain('tests/db/company-access-management.test.ts');
    const step = stepText(CI, 'DB probes (tests/db)');
    // The old comment blamed the parity wrapper; it now passes and runs here.
    expect(step).not.toMatch(/invite-authority-parity fail/);
    expect(step).not.toMatch(/and invite-authority-parity/);
  });

  it('reads both psql streams in the parity wrapper (PASS is a NOTICE on stderr) and checks the exit status', () => {
    const wrapper = readFileSync(join(process.cwd(), 'tests/db/invite-authority-parity.test.ts'), 'utf8');
    expect(wrapper).toContain('spawnSync');
    expect(wrapper).not.toContain('execFileSync');
    expect(wrapper).toMatch(/\.status\b/);
    expect(wrapper).toMatch(/\.stderr\b/);
    expect(wrapper).toMatch(/\.stdout\b/);
  });
});

describe('every SQL probe runs in CI (PL-15)', () => {
  const NOT_RUN = [
    'discovery_purge_timing',
    'skill-authoring-draft-contract',
    'skill_authoring',
    'skill_publication',
  ];

  it('runs each probe under supabase/tests through psql or a listed wrapper, except the known gaps', () => {
    const probeIn = (text: string) => [...text.matchAll(/supabase\/tests\/([\w-]+)\.sql/g)].map((m) => m[1]);
    const run = new Set([
      ...probeIn(stepText(CI, 'Run the integration suite')),
      ...dbVitestList(CI).flatMap((file) => probeIn(readFileSync(join(process.cwd(), file), 'utf8'))),
    ]);
    const probes = readdirSync(join(process.cwd(), 'supabase/tests'))
      .filter((name) => name.endsWith('.sql'))
      .map((name) => name.slice(0, -'.sql'.length));

    expect(probes.filter((probe) => !run.has(probe)).sort()).toEqual(NOT_RUN);
  });
});

describe('the CI list parser', () => {
  it('parses a list with continuations, and sees a dropped wrapper', () => {
    const sample = 'run: |\n  RUN_DB_TESTS=1 DATABASE_URL="$X" npx vitest run \\\n    tests/db/a.test.ts \\\n    tests/db/b.test.ts\n';
    expect(dbVitestList(sample)).toEqual(['tests/db/a.test.ts', 'tests/db/b.test.ts']);
    expect(dbVitestList(sample.replace('tests/db/b.test.ts', ''))).not.toContain('tests/db/b.test.ts');
    expect(dbVitestList('run: npx vitest run tests/x.test.ts')).toEqual([]);
  });
});
