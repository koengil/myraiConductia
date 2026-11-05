// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

import { SCOPE } from '@/lib/conductia/scopes';
import { AGENT_SURFACES, type MailboxDataDeclaration } from '@/lib/mailboxAccess/agentSurfaces';

import nameCollisions from './fixtures/agentSurfaces/nameCollisions.json';
import nonLiteralNames from './fixtures/agentSurfaces/nonLiteralNames.json';
import mailboxSqlFunctions from './fixtures/mailboxSqlFunctions.json';
import {
  brandCastHits,
  CONSTANT_HOMES,
  fenceProgram,
  hasUseServerDirective,
  isServerEntryPath,
  mailboxNameHits,
  productionFiles,
  type AstHit,
} from './helpers/fenceAst';
import { walk } from './helpers/walkRepo';

/**
 * Every agent-reachable surface declares whether it touches mailbox data, and
 * its import closure has to agree (#262, R13, R14, R21, R22, R24, R30). The
 * surfaces come from the tree, never from the manifest, so a new tool, route
 * or scope that nobody declared fails here. Fixture tools prove the detectors
 * fire.
 *
 * THREAT MODEL (audit round 1, item 12). These static fences (this file,
 * tests/mailbox-reader-fence.test.ts, tests/eslint-fences.test.ts, the ESLint
 * config) stop accidental and casual bypasses: a table named directly or
 * through a constant, a computed name, an import of a reader, a cast of the
 * ActingUser brand, a new server entry point that skips the guard. They read
 * the code with the TypeScript compiler (types, not text), so `TABLE['X']`,
 * destructuring, concatenation and re-exports are all seen. They do NOT stop a
 * developer who deliberately evades them (a value laundered through `any`, a
 * wrapper in an allowlisted file, a hand-built module graph the analysis cannot
 * follow). Two things back them:
 *   1. Run time. The reader factories demand a one-time capability that only
 *      src/lib/mailboxAccess/readers.ts holds, the guard builds its own
 *      service client, and RLS answers the signed-in reads. A bypass that gets
 *      past every fence still refuses (no_capability) or reads nothing.
 *      Limit: the capability is claimed once per module instance, by whichever
 *      module loads first. A hostile module that claims first gets it, and the
 *      legitimate load then throws on the second claim. That throw is loud
 *      only where readers.ts loads at boot: src/instrumentation.ts (Next,
 *      Node runtime), the top of worker/classify.ts and of each script that
 *      can reach a reader (tests/mailbox-access/boot-claim.test.ts pins
 *      them). A process that never loads readers.ts has no boot claim, so a
 *      hostile claim there is neither prevented nor noticed by code.
 *   2. Review. Deliberate evasion is caught by CODEOWNERS: src/lib/mailboxAccess/,
 *      src/lib/graph/reader/, src/lib/discovery/source/, eslint.config.mjs and the fence tests all
 *      require code-owner review (tests/mailbox-access-pins.test.ts pins the
 *      guard's exports and the CODEOWNERS entries).
 * Recorded in D68 of docs/07-decisions/decision-log.md.
 */

const ROOT = process.cwd();
// The type-based detectors need one ts.Program over the repo (about 5 s), and
// the repo-wide scans then type-check every value expression (about 15 s more).
// Built once here, so no single test pays for it against the 15 s default.
const SLOW = 120_000;
beforeAll(() => {
  fenceProgram();
}, SLOW);

const ACCESSORS = 'src/lib/mailboxAccess/accessors.ts';
// A guarded surface may import the accessors and the principal mint, nothing
// else from the guard module.
const GUARDED_DOORS = [ACCESSORS, 'src/lib/mailboxAccess/principal.ts'];
// Files whose mailbox-derived names are allowed to be non-literal: generic
// helpers that take a `string` table or function name. A caller that names a
// derived table is flagged in the caller (a literal or a TABLE.X expression),
// so the helper does not open a hole; each entry says why.
const NON_LITERAL_OK: ReadonlySet<string> = new Set((nonLiteralNames as Array<{ file: string }>).map((e) => e.file));
// Files that hold a string equal to a mailbox-derived name that is not that table.
const NAMES_OK = new Map<string, Set<string>>();
for (const { file, name } of nameCollisions as Array<{ file: string; name: string }>) {
  NAMES_OK.set(file, (NAMES_OK.get(file) ?? new Set()).add(name));
}
const ALLOW = { nonLiteral: NON_LITERAL_OK, namesOk: NAMES_OK };
const EXEMPT_FILES = [ACCESSORS, ...CONSTANT_HOMES];
export const isExemptFile = (file: string) => EXEMPT_FILES.includes(file);
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const hitCache = new Map<string, AstHit[]>();
/** Mailbox-derived table, view or RPC names in one file, by type (cached: closures overlap). */
export function nameHits(file: string): AstHit[] {
  if (isExemptFile(file) || !SOURCE_FILE.test(file)) return [];
  let hits = hitCache.get(file);
  if (!hits) hitCache.set(file, (hits = mailboxNameHits(file, ALLOW)));
  return hits;
}
// The one server entry that may load the readers module: Next's boot hook loads
// it only to claim the reader capability before a request (audit round 2, group
// A). It takes no reader from it, so it is not a surface that reads. Exact file
// and exact target: any other entry that imports readers.ts is still flagged.
const BOOT_CLAIM = { entry: 'src/instrumentation.ts', target: 'src/lib/mailboxAccess/readers.ts' };
const SDK = /^(?:@azure\/msal-node|google-auth-library|googleapis|@googleapis\/)/;

// 1. discover: surfaces from the tree, never from the manifest
export function discoverSurfaces(): string[] {
  const routes = walk('src/app/v1').filter((f) => f.endsWith('/route.ts'));
  const agents = walk('src/lib/orchestration/agents').filter((f) => /\.tsx?$/.test(f));
  const skillSource = readFileSync(join(ROOT, 'src/app/api/skill-service/route.ts'), 'utf8');
  // The declaration carries a `=>` in its type, so anchor on the last `= {`.
  const skillsBody = /const SKILLS\b[^\n]*=\s*\{\s*\n([\s\S]*?)\n\};/.exec(skillSource)?.[1] ?? '';
  const skills = [...skillsBody.matchAll(/^\s*['"]?([\w-]+)['"]?\s*:/gm)].map((m) => `skill:${m[1]}`);
  const scopes = Object.values(SCOPE).map((s) => `scope:${s}`);
  return [...routes, ...agents, 'src/app/api/skill-service/route.ts', ...skills, ...scopes].sort();
}

// 2. closure: static and dynamic imports, @/ resolved through tsconfig paths
const config = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile).config,
  ts.sys,
  ROOT,
);
function importsOf(file: string): { specifier: string; resolved: string | null }[] {
  const info = ts.preProcessFile(readFileSync(join(ROOT, file), 'utf8'), true, true);
  return info.importedFiles.map(({ fileName }) => {
    const hit = ts.resolveModuleName(fileName, join(ROOT, file), config.options, ts.sys).resolvedModule;
    const resolved = hit && !hit.isExternalLibraryImport ? relative(ROOT, hit.resolvedFileName) : null;
    return { specifier: fileName, resolved };
  });
}

// 3. detect and 4. judge, per surface
export type Hit = { file: string; what: string };
export function analyse(entry: string, declared: 'none' | 'guarded'): Hit[] {
  const seen = new Set<string>();
  const hits: Hit[] = [];
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const hit of nameHits(file)) hits.push({ file, what: hit.what });
    for (const { specifier, resolved } of importsOf(file)) {
      if (SDK.test(specifier)) hits.push({ file, what: `provider SDK ${specifier}` });
      if (!resolved) continue;
      if (resolved.startsWith('src/lib/discovery/')) hits.push({ file, what: `discovery import ${resolved}` });
      if (/^src\/lib\/(?:graph|google)\/reader\//.test(resolved)) hits.push({ file, what: `reader import ${resolved}` });
      if (resolved.startsWith('src/lib/mailboxAccess/')) {
        if (file === BOOT_CLAIM.entry && resolved === BOOT_CLAIM.target) continue;
        // The accessors are the one door for tools; nothing else in the guard module is.
        if (declared === 'none' || !GUARDED_DOORS.includes(resolved)) {
          hits.push({ file, what: `mailboxAccess import ${resolved}` });
        }
        continue; // the guard module is tested on its own
      }
      queue.push(resolved);
    }
  }
  return hits;
}

describe('agent surfaces declare mailbox data and keep to it (#262)', () => {
  it('finds the surfaces it is meant to find', () => {
    const found = discoverSurfaces();
    // A broken discovery pattern would make every other test here pass on nothing.
    expect(found).toContain('skill:target-universe');
    expect(found).toContain('scope:lead.read');
    expect(found).toContain('src/app/v1/library/route.ts');
    expect(found).toContain('src/lib/orchestration/agents/draft-agent.ts');
  });

  it('declares every surface found in the tree', () => {
    const missing = discoverSurfaces().filter((s) => !(s in AGENT_SURFACES));
    expect(missing, 'declare mailboxData in src/lib/mailboxAccess/agentSurfaces.ts').toEqual([]);
  });

  // A key is stale when its surface is gone. Discovered surfaces cover /v1
  // routes, agents, skills and scopes; any other server entry point may also be
  // declared (a guarded search or retrieval route under src/app/api, a page),
  // and is stale only when the file no longer exists (review round 4).
  it('has no stale manifest entries', () => {
    const found = new Set(discoverSurfaces());
    const stale = Object.keys(AGENT_SURFACES).filter((s) =>
      s.includes(':') || !isServerEntryPath(s) ? !found.has(s) : !existsSync(join(ROOT, s)),
    );
    expect(stale).toEqual([]);
  });

  it('passes a guarded route outside /v1 that reads through the accessor', () => {
    const fixture = 'tests/fixtures/agentSurfaces/api-v1-search-guarded-route.ts';
    const manifest = { 'src/app/api/v1/search/route.ts': { mailboxData: 'guarded' as const } };
    expect(judgeRoute('src/app/api/v1/search/route.ts', analyse(fixture, 'none'), fixture, manifest)).toBeNull();
  });

  it.each(Object.entries(AGENT_SURFACES).filter(([key]) => !key.includes(':')))(
    '%s keeps to its declaration',
    (file, declared) => {
      if (declared.mailboxData === 'definer_rpc') {
        expect(judgeRoute(file, analyse(file, 'none'))).toBeNull();
      } else {
        expect(analyse(file, declared.mailboxData)).toEqual([]);
      }
    },
  );

  it('flags a fixture tool that reads source_items directly', () => {
    expect(analyse('tests/fixtures/agentSurfaces/reads-source-items.ts', 'none')).not.toEqual([]);
    expect(analyse('tests/fixtures/agentSurfaces/reads-source-items.ts', 'guarded')).not.toEqual([]);
  });

  it('flags a fixture tool that imports the reader dynamically', () => {
    expect(analyse('tests/fixtures/agentSurfaces/imports-reader-dynamically.ts', 'guarded')).not.toEqual([]);
  });

  it('passes a fixture tool that uses the accessor and declares guarded', () => {
    expect(analyse('tests/fixtures/agentSurfaces/uses-accessor.ts', 'guarded')).toEqual([]);
    expect(analyse('tests/fixtures/agentSurfaces/uses-accessor.ts', 'none')).not.toEqual([]);
  });

  it('does not flag the send-as feature, which is not a mailbox-derived read', () => {
    expect(analyse('tests/fixtures/agentSurfaces/sends-mail-connection-probe.ts', 'none')).toEqual([]);
  });

  it('lets the boot hook load the readers module to claim the capability, and only that file', () => {
    expect(analyse('src/instrumentation.ts', 'none')).toEqual([]);
    expect(judgeRoute('src/instrumentation.ts', analyse('src/instrumentation.ts', 'none'))).toBeNull();
    // The same import from any other entry is flagged, declared or not.
    const fixture = 'tests/fixtures/agentSurfaces/imports-readers-at-boot.ts';
    expect(analyse(fixture, 'none')).not.toEqual([]);
    expect(analyse(fixture, 'guarded')).not.toEqual([]);
  });

  it('flags a guarded surface that imports the guard module directly', () => {
    expect(analyse('tests/fixtures/agentSurfaces/imports-guard-directly.ts', 'guarded')).not.toEqual([]);
  });
});

describe('a definer_rpc declaration passes only a route that calls service-role RPCs and nothing else (E5)', () => {
  const FIXTURES = 'tests/fixtures/agentSurfaces';
  const ROUTE = 'src/app/api/v1/deals/from-discovery/route.ts';
  const declare = (...rpcs: string[]): Record<string, MailboxDataDeclaration> => ({
    [ROUTE]: { mailboxData: 'definer_rpc', rpcs },
  });
  const judge = (fixture: string, manifest: Record<string, MailboxDataDeclaration>) =>
    judgeRoute(ROUTE, analyse(`${FIXTURES}/${fixture}`, 'none'), `${FIXTURES}/${fixture}`, manifest);

  it('passes a route that names only its declared service-role RPC', () => {
    const hits = analyse(`${FIXTURES}/definer-rpc-route.ts`, 'none');
    expect(hits.length, 'the fixture must name the RPC, or the pass proves nothing').toBeGreaterThan(0);
    expect(judge('definer-rpc-route.ts', declare('discovery_record_assessment'))).toBeNull();
  });

  it('does not pass the same route under none, guarded or no declaration', () => {
    expect(judge('definer-rpc-route.ts', {})).not.toBeNull();
    expect(judge('definer-rpc-route.ts', { [ROUTE]: { mailboxData: 'none' } })).not.toBeNull();
    expect(judge('definer-rpc-route.ts', { [ROUTE]: { mailboxData: 'guarded' } })).not.toBeNull();
  });

  it('fails a route that also names a discovery table', () => {
    const verdict = judge('definer-rpc-route-and-table.ts', declare('discovery_record_assessment'));
    expect(verdict).toContain('beyond its declared definer RPCs');
    expect(verdict).toContain('deal_candidates');
  });

  it('fails a route that imports src/lib/discovery/, even a pure module', () => {
    const verdict = judge('definer-rpc-route-imports-discovery.ts', declare('discovery_record_assessment'));
    expect(verdict).toContain('discovery import src/lib/discovery/milestones.ts');
  });

  it('fails a route that goes through the accessors, a reader or an SDK, which no declaration names', () => {
    expect(judge('uses-accessor.ts', declare('discovery_record_assessment'))).toContain('beyond its declared definer RPCs');
    expect(judge('imports-reader-dynamically.ts', declare('discovery_record_assessment'))).not.toBeNull();
    expect(judge('imports-readers-at-boot.ts', declare('discovery_record_assessment'))).not.toBeNull();
  });

  it('fails a route that names an RPC it did not declare', () => {
    expect(judge('definer-rpc-route.ts', declare('discovery_extract_batch'))).toContain('beyond its declared definer RPCs');
  });

  it('fails a declaration of an RPC granted to authenticated', () => {
    const verdict = judge('definer-rpc-route-authenticated-rpc.ts', declare('discovery_rename_candidate'));
    expect(verdict).toContain('executable by authenticated');
    // Also when the route itself would otherwise be clean.
    expect(judge('definer-rpc-route.ts', declare('discovery_record_assessment', 'discovery_correction_authority'))).toContain(
      'discovery_correction_authority/2 is executable by authenticated',
    );
  });

  it('fails a declaration of a name that is not classified in mailboxSqlFunctions.json', () => {
    // create_deal_gate0_core is service_role only but reads no mailbox table, so it is not listed.
    expect(judge('definer-rpc-route.ts', declare('discovery_record_assessment', 'create_deal_gate0_core'))).toContain(
      'create_deal_gate0_core is not classified',
    );
  });

  it('fails a declaration with no RPC, and one that no migration defines', () => {
    expect(judge('definer-rpc-route.ts', declare())).toContain('declares no RPC');
    expect(definerDeclarationProblems(['discovery_record_assessment', 'no_such_function'])).toEqual([
      'no_such_function is not classified in tests/fixtures/mailboxSqlFunctions.json',
      'no_such_function is defined by no migration',
    ]);
  });

  it('is judged by the declaration only outside the session-RLS zones', () => {
    const zoneRoute = 'src/app/api/v1/discovery/probe/route.ts';
    const fixture = `${FIXTURES}/definer-rpc-route.ts`;
    // In a zone the zone rules apply (this fixture builds a service-role client there), declared or not.
    expect(judgeRoute(zoneRoute, analyse(fixture, 'none'), fixture, { [zoneRoute]: { mailboxData: 'definer_rpc', rpcs: ['discovery_record_assessment'] } })).not.toBeNull();
  });

  describe('reads who may execute a function from the migrations', () => {
    const mig = (...sql: string[]) => sql.map((text, i) => ({ file: `${i + 1}.sql`, sql: text }));
    const who = (migrations: ReturnType<typeof mig>, key: string) => [...(executeRoles(migrations).get(key) ?? [])].sort();
    const fn = 'create function f(a uuid, b text default null) returns int language sql as $$ select 1; $$;';

    it('starts a new function open to PUBLIC, as Postgres does', () => {
      expect(who(mig(fn), 'f/2')).toEqual(['public']);
    });
    it('closes it with revoke and opens it to service_role with grant', () => {
      const closed = 'revoke all on function f(uuid, text) from public, anon, authenticated;';
      expect(who(mig(fn, closed), 'f/2')).toEqual([]);
      expect(who(mig(fn, closed, 'grant execute on function f(uuid, text) to service_role;'), 'f/2')).toEqual(['service_role']);
    });
    it('sees a later grant to authenticated, across files, and in a multi-function list', () => {
      const closed = 'revoke all on function f(uuid, text) from public; grant execute on function f(uuid, text) to service_role;';
      const later = 'grant execute on function\n  g(uuid), f(uuid, text)\n  to authenticated;';
      expect(who(mig(fn, closed, later), 'f/2')).toEqual(['authenticated', 'service_role']);
    });
    it('keeps grants across create or replace and forgets a dropped function', () => {
      const closed = 'revoke all on function f(uuid, text) from public; grant execute on function f(uuid, text) to service_role;';
      expect(who(mig(fn, closed, fn.replace('create function', 'create or replace function')), 'f/2')).toEqual(['service_role']);
      expect(who(mig(fn, closed, 'drop function if exists f(uuid, text);'), 'f/2')).toEqual([]);
    });
    it('keeps overloads apart by argument count', () => {
      const other = 'create function f(a uuid) returns int language sql as $$ select 1; $$; revoke all on function f(uuid) from public;';
      expect(who(mig(fn, other), 'f/1')).toEqual([]);
      expect(who(mig(fn, other), 'f/2')).toEqual(['public']);
    });
    it('ignores a grant that only appears in a comment or a string', () => {
      const noise = "-- grant execute on function f(uuid, text) to authenticated;\ncomment on function f(uuid, text) is 'grant execute on function f(uuid, text) to anon;';";
      expect(who(mig(fn, 'revoke all on function f(uuid, text) from public;', noise), 'f/2')).toEqual([]);
    });
    it('rejects a declaration whose function was left open to PUBLIC or opened to authenticated', () => {
      const listed = 'discovery_record_assessment';
      const real = readMigrations();
      expect(definerDeclarationProblems([listed], real)).toEqual([]);
      expect(definerDeclarationProblems([listed], [...real, { file: '99999999999999_open.sql', sql: 'grant execute on function discovery_record_assessment(uuid, uuid, jsonb, text, uuid) to authenticated;' }])).toEqual([
        `${listed}/5 is executable by authenticated, service_role; a definer_rpc must be service_role only`,
      ]);
      expect(definerDeclarationProblems([listed], [...real, { file: '99999999999999_open.sql', sql: 'grant execute on function discovery_record_assessment(uuid, uuid, jsonb, text, uuid) to public;' }])).toEqual([
        `${listed}/5 is executable by public, service_role; a definer_rpc must be service_role only`,
      ]);
    });
  });
});

describe('mailbox-derived table names live only in their homes', () => {
  // Files that may name a mailbox-derived table or view: the worker's writer
  // and the session-side reader, the guard module, the two constants files that
  // define the names (no other file under constants/ is exempt), the worker,
  // the discovery seed, the registration scripts (Graph and Google) and the schema preflight.
  const HOMES = [
    'src/lib/discovery/persist.ts',
    'src/lib/discovery/api.ts',
    // The deal-zone extractor's Supabase store (service role, worker only): names the milestone and link tables.
    'src/lib/discovery/extract/',
    // The demo-only proposal step's Supabase store (#460; service role, worker only): names the proposal and
    // candidate tables. Deleted with the step when #459 lands.
    'src/lib/discovery/propose/store.ts',
    // Its session-side reader (#460): the caller's scoped client, under RLS, for the /discovery section.
    'src/lib/discovery/propose/read.ts',
    // The session-side origin and accepted-proposal reads (G-02b #173): the caller's scoped client, under RLS, for
    // the candidate page and the rail marker. Names the candidate and accept tables.
    'src/lib/discovery/origin.ts',
    'src/lib/mailboxAccess/',
    ...CONSTANT_HOMES,
    'worker/',
    'scripts/seed-discovery.ts',
    // The operator's registration script (#243) writes a bank's reader registration and its explicit
    // content_sources list (Q6); it reads no mailbox data.
    'scripts/m365/write-registration.ts',
    // The deployment preflight names the tables it checks in a live database; it reads no rows.
    'scripts/preflight-db.ts',
    // The deal-discovery eval export (phase 5, design Q15): a read-only, per-tenant export of discovery
    // metadata (identifiers, dates, decisions; never source_item_texts, a subject, a participant or a body)
    // for the harness in evals/deal-discovery. Operator-run with a service-role client, writes nothing to
    // the database, and is never reached by a request, the worker or an agent.
    'scripts/discovery-export.ts',
    // The cassette replay (CDT-277): seeds a throwaway tenant of a LOCAL Supabase (loopback-only, production
    // refused) with sources and a disabled registration, then counts what a replayed pass stored. Its reads
    // of mail go through runOnce, which wraps the cassette reader in the mailbox guard.
    'scripts/m365/replay-discovery.ts',
    // The live recorder's readiness check (#318): lists the tenant's active Microsoft sources (id, kind, address,
    // owner, halt marker; no mail) and asks the mailbox guard about each, the way the worker names its sources
    // before it reads. It reads no mail, and is run by hand by the owner (--preflight, then the capture).
    'scripts/m365/cassette/readiness.ts',
    // The Google registration writer creates the tenant's Google content_sources rows (address and
    // owner, no mail); an operator script run by hand (#259).
    'scripts/google/write-registration.ts',
    // The connection probe's guard builder (#344, design R15): reads one address's content_sources owner
    // and whether it has an allowed_mailboxes row, so the probe asks the #262 guard the way the worker
    // does. It reads no mail; the probe runs by hand or as the fixed-command probe task.
    'scripts/google/lib/probeGuard.ts',
    // The #173 demo rehearsal's probes: service-role head counts of the team source's index and proposal rows, and
    // its content_sources id and window (ids, dates and codes; no mail). Pinned to the local w9-m365cap stack
    // (assertRehearsalStack) and run by hand through scripts/rehearsal/rehearse.sh, never by a request or an agent.
    'scripts/rehearsal/probes.ts',
  ];
  const isHome = (f: string) => HOMES.some((home) => f.startsWith(home));

  it('finds none elsewhere, in any top-level folder except tests, e2e, node_modules and .next', () => {
    const offenders = productionFiles()
      .filter((f) => !isHome(f))
      .flatMap((f) => nameHits(f).filter((h) => h.kind !== 'rpc').map((h) => `${f}:${h.line} ${h.what}`));
    expect(offenders).toEqual([]);
  }, SLOW);

  it('exempts only tables.ts and discovery.ts under constants/', () => {
    expect(isExemptFile('src/lib/constants/tables.ts')).toBe(true);
    expect(isExemptFile('src/lib/constants/discovery.ts')).toBe(true);
    expect(isExemptFile('src/lib/constants/anythingElse.ts')).toBe(false);
    expect(isHome('src/lib/constants/anythingElse.ts')).toBe(false);
  });
});

// Review round 1: every route is analysed, listed in the manifest or not, so a
// new search or retrieval route under src/app/api cannot skip the guard.
// fence A: session client only, RLS applies. eslint.config.mjs fences the same
// two app folders; a page there is as much a discovery surface as a route.
const SESSION_RLS_ZONES = ['src/app/api/v1/discovery/', 'src/app/(authed)/discovery/'];
// Review round 2: fence A blocks direct imports only, so being in the zone is
// not enough. In a zone route's closure, the files that touch mailbox data may
// only be the route itself and the session-data modules, which take the
// caller's scoped client as a parameter; none of those may build a
// service-role client. Other files may use the service role for non-mailbox
// work (requireFlag reads feature_flags through the admin client).
// The demo-only proposal reader (#460; deleted with #459) is one: it takes the scoped client the same way.
// So is the origin read (G-02b #173), which the candidate detail and the suggestions route call.
const SESSION_DATA_MODULES = ['src/lib/discovery/api.ts', 'src/lib/discovery/propose/read.ts', 'src/lib/discovery/origin.ts'];
// createClient( is the raw supabase-js constructor: a zone data file that builds
// its own client with a key has stepped around requireApiUserScoped (item 8).
const SERVICE_ROLE =
  /\bcreateSupabaseAdminClient\s*\(|\brequireApiUser\s*\(|\bcreateClient\s*\(|\bSUPABASE_SECRET_KEY\b|\bSUPABASE_SERVICE_ROLE_KEY\b/;
const touchesMailbox = (file: string) => nameHits(file).length > 0;
export function closureOf(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { resolved } of importsOf(file)) if (resolved) queue.push(resolved);
  }
  return [...seen];
}

// E5 (#262 review, conditions a and b): a server route outside the session-RLS
// zones (Gate 0's zone) may reach mailbox data through service-role definer
// RPCs alone, declared as { mailboxData: 'definer_rpc', rpcs }. The route's
// closure may then carry exactly those names. A table, a src/lib/discovery/
// import, a reader, an SDK or a mailboxAccess import has no declared name, so
// it fails like any other hit. The declaration itself is checked against the
// SQL: every name is classified in mailboxSqlFunctions.json and, read from the
// migrations, executable by service_role and nobody else.
type SqlMigration = { file: string; sql: string };

function stripSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gi, "''")
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** `(uuid, text)` at `open` in `text`: the argument count and the index after the closing paren. */
function argsAt(text: string, open: number): { arity: number; end: number } {
  let depth = 0;
  let commas = 0;
  let any = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return { arity: any ? commas + 1 : 0, end: i + 1 };
    else if (depth === 1) {
      if (c === ',') commas++;
      else if (!/\s/.test(c)) any = true;
    }
  }
  throw new Error('unbalanced argument list');
}

const FN_REF = /(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
const fnRefs = (list: string): string[] =>
  [...list.matchAll(FN_REF)].map((m) => `${m[1].toLowerCase()}/${argsAt(list, (m.index ?? 0) + m[0].length - 1).arity}`);

/**
 * Who may EXECUTE each function (`name/arity`) after the migrations run, from
 * the statements themselves: a new function starts executable by PUBLIC (the
 * Postgres default), `create or replace` keeps its grants, `grant` and
 * `revoke ... on function` edit the set, `drop` forgets it. Deliberately
 * conservative: a function whose only closing is a bulk DO block (as
 * 20260929170000 did for the functions that existed then) reads as open here,
 * so a definer_rpc declaration needs explicit statements of its own.
 */
export function executeRoles(migrations: SqlMigration[]): Map<string, Set<string>> {
  const roles = new Map<string, Set<string>>();
  for (const { sql } of [...migrations].sort((a, b) => a.file.localeCompare(b.file))) {
    for (const raw of stripSql(sql).split(';')) {
      const stmt = raw.trim();
      const create = /^create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/i.exec(stmt);
      if (create) {
        const key = `${create[1].toLowerCase()}/${argsAt(stmt, create[0].length - 1).arity}`;
        if (!roles.has(key)) roles.set(key, new Set(['public']));
        continue;
      }
      const drop = /^drop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*(\()?/i.exec(stmt);
      if (drop) {
        const name = drop[1].toLowerCase();
        for (const key of [...roles.keys()]) if (key.startsWith(`${name}/`)) roles.delete(key);
        continue;
      }
      const edit = /^(grant|revoke)\s+(?:execute|all(?:\s+privileges)?)\s+on\s+function\s+([\s\S]+?)\s+(?:to|from)\s+([\s\S]+)$/i.exec(stmt);
      if (!edit) continue;
      const who = edit[3].replace(/\s+with\s+grant\s+option\s*$/i, '').split(',').map((r) => r.trim().replace(/"/g, '').toLowerCase());
      for (const key of fnRefs(edit[2])) {
        const set = roles.get(key) ?? new Set(['public']);
        roles.set(key, set);
        const granting = edit[1].toLowerCase() === 'grant';
        for (const role of who) {
          if (granting) set.add(role);
          else set.delete(role);
        }
      }
    }
  }
  return roles;
}

let migrationCache: SqlMigration[] | undefined;
function readMigrations(): SqlMigration[] {
  const dir = join(ROOT, 'supabase/migrations');
  return (migrationCache ??= readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => ({ file, sql: readFileSync(join(dir, file), 'utf8') })));
}

const CLASSIFIED_RPCS: ReadonlySet<string> = new Set((mailboxSqlFunctions as Array<{ name: string }>).map((f) => f.name));

/** Why a definer_rpc declaration is not acceptable, before any hit is looked at. */
export function definerDeclarationProblems(
  rpcs: readonly string[],
  migrations: SqlMigration[] = readMigrations(),
): string[] {
  if (rpcs.length === 0) return ['declares no RPC'];
  const roles = executeRoles(migrations);
  return rpcs.flatMap((rpc) => {
    const problems: string[] = [];
    if (!CLASSIFIED_RPCS.has(rpc)) problems.push(`${rpc} is not classified in tests/fixtures/mailboxSqlFunctions.json`);
    const overloads = [...roles].filter(([key]) => key.startsWith(`${rpc}/`));
    if (overloads.length === 0) problems.push(`${rpc} is defined by no migration`);
    for (const [key, who] of overloads) {
      if ([...who].sort().join(',') !== 'service_role') {
        problems.push(`${key} is executable by ${[...who].sort().join(', ') || 'no one'}; a definer_rpc must be service_role only`);
      }
    }
    return problems;
  });
}

// The names a hit carries, from the labels mailboxNameHits emits. A `.from(x)`
// is never a declared RPC, so a table read through it has no name here.
const HIT_NAME = [
  /^names mailbox-derived '([^']+)'$/,
  /^\.rpc\(([^)]+)\) reaches a mailbox-derived name$/,
  /^expression of type '([^']+)' \(mailbox-derived\)$/,
];
const hitName = (what: string): string | null => {
  for (const pattern of HIT_NAME) {
    const name = pattern.exec(what)?.[1];
    if (name) return name;
  }
  return null;
};

export function judgeRoute(
  route: string,
  hits: Hit[],
  entry: string = route,
  manifest: Record<string, MailboxDataDeclaration> = AGENT_SURFACES,
): string | null {
  const declared = manifest[route];
  if (declared?.mailboxData === 'definer_rpc' && !SESSION_RLS_ZONES.some((zone) => route.startsWith(zone))) {
    const bad = definerDeclarationProblems(declared.rpcs);
    const extra = hits.filter((h) => {
      const name = hitName(h.what);
      return name === null || !declared.rpcs.includes(name);
    });
    const problems = [
      ...bad,
      ...(extra.length ? [`touches mailbox data beyond its declared definer RPCs: ${extra.map((h) => `${h.file}: ${h.what}`).join(' | ')}`] : []),
    ];
    return problems.length ? `${route}: ${problems.join('; ')}` : null;
  }
  if (hits.length === 0) return null;
  if (SESSION_RLS_ZONES.some((zone) => route.startsWith(zone))) {
    const problems = closureOf(entry)
      .filter((f) => !CONSTANT_HOMES.includes(f))
      .flatMap((f) => {
        const text = readFileSync(join(ROOT, f), 'utf8');
        const dataFile = f === entry || SESSION_DATA_MODULES.includes(f);
        if (touchesMailbox(f) && !dataFile) return [`${f} touches mailbox data outside the session-data modules`];
        if (dataFile && SERVICE_ROLE.test(text)) return [`${f} builds a service-role client`];
        return [];
      });
    return problems.length ? `${route}: ${problems.join('; ')}` : null;
  }
  if (declared?.mailboxData === 'guarded') {
    return analyse(entry, 'guarded').length ? `${route}: touches mailbox data outside the accessors` : null;
  }
  return `${route}: touches mailbox data; move it under ${SESSION_RLS_ZONES[0]} or declare it guarded`;
}

/**
 * Every server entry point: an App Router special file (route, page, layout,
 * default, template, error, metadata routes), the middleware/proxy/instrumentation
 * hooks, and any file with a 'use server' directive (file level or inline in a
 * function), wherever it lives. A page or a server action runs on the server
 * with the same reach as a route, so it is judged the same way (item 5).
 */
export function serverEntries(files: string[] = productionFiles(), read = (f: string) => readFileSync(join(ROOT, f), 'utf8')): string[] {
  return files.filter((f) => isServerEntryPath(f) || hasUseServerDirective(read(f), f));
}

describe('every server entry point that touches mailbox data is session-scoped or guarded', () => {
  it('finds the entry points it is meant to find', () => {
    const found = serverEntries();
    expect(found).toContain('src/app/api/v1/discovery/candidates/route.ts');
    expect(found.some((f) => f.endsWith('/page.tsx'))).toBe(true);
    expect(found.some((f) => f.endsWith('/layout.tsx'))).toBe(true);
  });

  it('holds for every route, page, layout and server action', () => {
    const problems = serverEntries()
      .map((entry) => {
        const hits = analyse(entry, 'none');
        const verdict = judgeRoute(entry, hits);
        return verdict && `${verdict} [${hits.map((h) => `${h.file}: ${h.what}`).join(' | ')}]`;
      })
      .filter(Boolean);
    expect(problems).toEqual([]);
  }, SLOW);

  it('recognises page, layout and the other special files, and ignores ordinary modules', () => {
    for (const f of ['src/app/(authed)/x/page.tsx', 'src/app/x/layout.tsx', 'src/app/api/x/route.ts', 'src/app/x/template.tsx', 'src/app/x/error.tsx', 'src/middleware.ts', 'middleware.ts', 'src/app/icon.tsx']) {
      expect(isServerEntryPath(f), f).toBe(true);
    }
    for (const f of ['src/components/Page.tsx', 'src/lib/route.ts', 'src/app/x/Form.tsx', 'src/app/x/page-helpers.ts']) {
      expect(isServerEntryPath(f), f).toBe(false);
    }
  });

  it('recognises a use server directive at file level and inline, and nothing that only mentions it', () => {
    expect(hasUseServerDirective("'use server';\nexport async function save() {}")).toBe(true);
    expect(hasUseServerDirective('"use strict";\n"use server";\nexport const x = 1;')).toBe(true);
    expect(hasUseServerDirective("export async function page() {\n  async function save() {\n    'use server';\n  }\n  return save;\n}")).toBe(true);
    expect(hasUseServerDirective("export const note = 'use server';")).toBe(false);
    expect(hasUseServerDirective("import x from 'y';\n'use server';")).toBe(false);
    expect(hasUseServerDirective("export function f() { const s = 'use server'; return s; }")).toBe(false);
  });

  it('discovers a page, a layout and a use server file in a virtual tree', () => {
    const tree: Record<string, string> = {
      'src/app/(authed)/x/page.tsx': 'export default function P() { return null; }',
      'src/app/(authed)/x/layout.tsx': 'export default function L() { return null; }',
      'src/lib/actions.ts': "'use server';\nexport async function save() {}",
      'src/lib/plain.ts': 'export const x = 1;',
    };
    expect(serverEntries(Object.keys(tree), (f) => tree[f])).toEqual([
      'src/app/(authed)/x/page.tsx',
      'src/app/(authed)/x/layout.tsx',
      'src/lib/actions.ts',
    ]);
  });

  it.each([
    ['a page', 'src/app/(authed)/leak/page.tsx', 'tests/fixtures/serverEntries/page.tsx'],
    ['a layout', 'src/app/(authed)/leak/layout.tsx', 'tests/fixtures/serverEntries/layout.tsx'],
    ['a use server file', 'src/lib/leak/actions.ts', 'tests/fixtures/serverEntries/actions.ts'],
    ['an inline server action', 'src/app/(authed)/leak/inline/page.tsx', 'tests/fixtures/serverEntries/inline-action.tsx'],
  ])('flags %s that reads source_items with the admin client', (_name, claimedPath, fixture) => {
    expect(judgeRoute(claimedPath, analyse(fixture, 'none'), fixture)).not.toBeNull();
    // Discovered by its (claimed) path or by its directive, whatever its name.
    expect(serverEntries([claimedPath], () => readFileSync(join(ROOT, fixture), 'utf8'))).toEqual([claimedPath]);
  });

  it('flags a discovery-zone page that reads mailbox data outside the session-data modules', () => {
    const fixture = 'tests/fixtures/serverEntries/page.tsx';
    expect(judgeRoute('src/app/(authed)/discovery/leak/page.tsx', analyse(fixture, 'none'), fixture)).not.toBeNull();
  });

  it('flags a new search route that reads source_items with the admin client', () => {
    const fixture = 'tests/fixtures/agentSurfaces/api-v1-search-route.ts';
    expect(judgeRoute('src/app/api/v1/search/route.ts', analyse(fixture, 'none'), fixture)).not.toBeNull();
  });

  it('flags a discovery-zone route that gets a service-role client through a helper', () => {
    const fixture = 'tests/fixtures/agentSurfaces/discovery-route-admin-via-helper.ts';
    expect(judgeRoute('src/app/api/v1/discovery/probe/route.ts', analyse(fixture, 'none'), fixture)).not.toBeNull();
  });

  it('flags a discovery-zone route that builds a raw supabase-js client', () => {
    const fixture = 'tests/fixtures/serverEntries/discovery-raw-client.ts';
    expect(judgeRoute('src/app/api/v1/discovery/probe/route.ts', analyse(fixture, 'none'), fixture)).not.toBeNull();
  });
});

/**
 * Each fixture marks the lines the detector must flag with a trailing FLAG
 * comment; every other line must stay clean. The marked lines are the bypass
 * variants the audit named; the unmarked ones are the legitimate look-alikes
 * (Array.from, Buffer.from, a non-derived table).
 */
function markedLines(fixture: string): number[] {
  return readFileSync(join(ROOT, fixture), 'utf8')
    .split('\n')
    .flatMap((line, i) => (/\/\/ FLAG\b/.test(line) ? [i + 1] : []));
}

describe('the name detector sees through the bypass variants (AST and types, item 4)', () => {
  it('flags exactly the marked lines of the variants fixture', () => {
    const fixture = 'tests/fixtures/fenceBypass/mailbox-names.ts';
    const flagged = [...new Set(mailboxNameHits(fixture).map((h) => h.line))].sort((a, b) => a - b);
    expect(flagged).toEqual(markedLines(fixture));
    expect(markedLines(fixture).length).toBeGreaterThan(10);
  });

  it('flags a constant re-exported from a non-exempt file, and the file that consumes it', () => {
    const reexport = 'tests/fixtures/fenceBypass/reexport-constant.ts';
    const consumer = 'tests/fixtures/fenceBypass/reexport-consumer.ts';
    expect(mailboxNameHits(reexport).map((h) => h.line)).toEqual(markedLines(reexport));
    expect(mailboxNameHits(consumer).map((h) => h.line)).toEqual(markedLines(consumer));
    expect(analyse(consumer, 'none')).not.toEqual([]);
  });

  it('lets the listed generic helpers take a non-literal name, and nothing else', () => {
    const fixture = 'tests/fixtures/fenceBypass/mailbox-names.ts';
    const lenient = mailboxNameHits(fixture, { nonLiteral: new Set([fixture]) });
    expect(lenient.length).toBeLessThan(mailboxNameHits(fixture).length);
    // A derived literal is flagged even in an allowlisted file.
    expect(lenient.some((h) => h.what.includes('mailbox-derived'))).toBe(true);
  });

  it('lists every non-literal allowance with a reason and a file that still exists', () => {
    for (const entry of nonLiteralNames as Array<{ file: string; reason: string }>) {
      expect(entry.reason.length, entry.file).toBeGreaterThan(30);
      expect(existsSync(join(ROOT, entry.file)), entry.file).toBe(true);
    }
  });
});

describe('the ActingUser brand is minted only in principal.ts', () => {
  it('has no cast to ActingUser or ScopedApiUser, and no brand-context escape cast, elsewhere', () => {
    const offenders = productionFiles()
      .filter((f) => f !== 'src/lib/mailboxAccess/principal.ts')
      .flatMap((f) => brandCastHits(f).map((h) => `${f}:${h.line} ${h.what}`));
    expect(offenders).toEqual([]);
  }, SLOW);

  it('flags every forgery variant in the fixture: as, angle brackets, unknown, alias, never, any', () => {
    const fixture = 'tests/fixtures/fenceBypass/brand-casts.ts';
    const flagged = [...new Set(brandCastHits(fixture).map((h) => h.line))].sort((a, b) => a - b);
    expect(flagged).toEqual(markedLines(fixture));
    expect(markedLines(fixture).length).toBeGreaterThanOrEqual(6);
  });
});
