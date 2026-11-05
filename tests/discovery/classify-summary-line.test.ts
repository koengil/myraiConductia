// @vitest-environment node
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { CLASSIFY_USAGE, ROUTING_READ_LABEL, summaryLine, usageError, type RunSummary } from '../../worker/classify';

// The line classify-once prints (#460): the existing counts, then the Routing part, the coverage answer. UUIDs,
// integers and fixed words only (#344, design R12): no subject, address, name or codename can reach it.

const TENANT = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const SOURCE = '33333333-3333-4333-8333-333333333333';

function okSummary(routing: Partial<Extract<RunSummary, { status: 'ok' }>['routing']> = {}): RunSummary {
  return {
    tenantId: TENANT,
    status: 'ok',
    runId: RUN,
    sources: 3,
    itemsRead: 17,
    itemsStored: 8,
    fetched: 17,
    excluded: 1,
    screening: { screened: 16, flagged: 2 },
    candidates: [
      { clusterKey: 'codename:falcon', candidateId: '44444444-4444-4444-8444-444444444441', created: true },
      { clusterKey: 'codename:cobra', candidateId: '44444444-4444-4444-8444-444444444442', created: false },
    ],
    refused: [],
    skipped: [],
    allowlist: 'in_sync',
    providers: [{ provider: 'microsoft', allowlist: 'in_sync', sources: 3, refused: [] }],
    passes: [{ sourceId: SOURCE, passId: '55555555-5555-4555-8555-555555555555' }],
    routing: { read: 17, routed: 10, unrouted: 6, skipped: 1, collisions: 0, codenames: 2, fullRead: true, scopeBlocked: 0, ...routing },
  };
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

describe('summaryLine (#460)', () => {
  it('appends the Routing counts to the run line, labelled as a full read', () => {
    expect(summaryLine(okSummary())).toBe(
      `Tenant ${TENANT}: read 17 items from 3 sources, stored 8, fetched 17, excluded 1, screened 16 (2 flagged by the rules), ` +
        '2 candidates (1 new), 0 refused, 0 skipped (no reader), allowlist in_sync (microsoft in_sync). ' +
        `Routing (full read): of 17 read, routed 10, unrouted 6, skipped 1, collisions 0; codenames 2. Scope-blocked routes 0. Run ${RUN}.`,
    );
  });

  it('prints the scope-blocked routes as a number, apart from the partition of what was read', () => {
    const line = summaryLine(okSummary({ scopeBlocked: 7 }));
    expect(line).toContain('codenames 2. Scope-blocked routes 7. Run ');
    // The partition is untouched: a refused route is not a fifth kind of read item.
    expect(line).toContain('of 17 read, routed 10, unrouted 6, skipped 1, collisions 0;');
  });

  it('says "new mail only since the last pass" when a source was not read whole', () => {
    expect(summaryLine(okSummary({ fullRead: false }))).toContain(
      'Routing (new mail only since the last pass): of 17 read, routed 10, unrouted 6, skipped 1, collisions 0; codenames 2. Scope-blocked routes 0.',
    );
    expect(Object.values(ROUTING_READ_LABEL)).toEqual(['full read', 'new mail only since the last pass']);
  });

  it('prints only UUIDs, integers and the fixed words of the format, for both labels', () => {
    const shape = new RegExp(
      `^Tenant ${UUID}: read \\d+ items from \\d+ sources, stored \\d+, fetched \\d+, excluded \\d+, screened \\d+ \\(\\d+ flagged by the rules\\), ` +
        `\\d+ candidates \\(\\d+ new\\), \\d+ refused, \\d+ skipped \\(no reader\\), allowlist [a-z_]+ \\((?:[a-z]+ [a-z_]+(?:, )?)*\\)\\. ` +
        `Routing \\((?:full read|new mail only since the last pass)\\): of \\d+ read, routed \\d+, unrouted \\d+, skipped \\d+, collisions \\d+; codenames \\d+\\. Scope-blocked routes \\d+\\. Run ${UUID}\\.$`,
    );
    for (const fullRead of [true, false]) {
      const line = summaryLine(okSummary({ fullRead }));
      expect(line).toMatch(shape);
      // The candidates' cluster keys carry the codename: the line counts them and never names one.
      expect(line).not.toMatch(/falcon|cobra|@/i);
    }
  });

  it('keeps the skipped line as it was', () => {
    expect(summaryLine({ tenantId: TENANT, status: 'skipped', reason: 'flag_disabled', passes: [] })).toBe(
      `Tenant ${TENANT}: skipped (flag_disabled).`,
    );
  });
});

describe('--recount is a usage error with --serve (#460)', () => {
  it('names the combination by a fixed code, and nothing else', () => {
    expect(usageError(['--serve', '--recount'])).toBe(CLASSIFY_USAGE.RECOUNT_WITH_SERVE);
    expect(usageError(['--recount', '--tenant', TENANT])).toBeNull();
    expect(usageError(['--serve'])).toBeNull();
    expect(usageError([])).toBeNull();
  });

  it('the CLI exits 2 with one fatal line carrying the code, before it builds a client', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'worker/classify.ts', '--serve', '--recount'], {
      cwd: process.cwd(),
      // A minimal environment: no database, so a client built by mistake would fail differently.
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code, err).toBe(2);
    expect(out.trim().split('\n').map((line) => JSON.parse(line))).toEqual([{ evt: 'fatal', reason: 'recount_with_serve' }]);
    expect(err).toBe('');
  }, 60_000);
});
