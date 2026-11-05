// @vitest-environment node
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { walk } from './helpers/walkRepo';

/**
 * The station-writer allow-list fence (G-02b #173, design R1). "Enforcement is: no machine writer can reach a station
 * writer." Any module under src/, worker/ or scripts/ that
 *
 *   - passes the name of a station RPC to a call (`db.rpc('discovery_set_station', ...)`), or
 *   - writes the deal cursor or the candidate's station override: an object key or an assignment named
 *     current_step_seq, current_deal_step_id, station_override_step_id or station_override_correction_id, or a step
 *     row's `status: 'current'` (the deal_steps cursor),
 *
 * fails CI unless it is on the allow list below, with exactly the names listed for it. The worker, the discovery
 * detect, propose and extract folders and the agents are not on it, so none of them can move a station or a pin.
 * A read does not trip it: a column named inside a select string, a type, or a property access that is read.
 * SQL definers are outside the scan (the SQL suites cover the accept path); a route that is listed takes its actor from
 * the signed-in session, and discovery_set_station refuses a null auth.uid().
 *
 * Syntax, not text: the match is on the TypeScript tree, so a comment, a string and a type never count. What it cannot
 * see is a name built at run time; the reviewer of any change to this list is the guard against that.
 */

const STATION_RPCS = new Set([
  'deal_move_cursor',
  'deal_step_save',
  'rail_skip_step',
  'rail_remove_step',
  'rail_restore_step',
  'discovery_promote_candidate',
  'discovery_set_station',
]);
const CURSOR_COLUMNS = new Set([
  'current_step_seq',
  'current_deal_step_id',
  'station_override_step_id',
  'station_override_correction_id',
]);
/** The deal_steps cursor is the step whose status is 'current'. */
const STEP_CURSOR = 'deal_steps.status=current';

export type Allowed = { file: string; names: string[]; reason: string };

/** Session routes and the discovery API: each acts for the signed-in caller. The names are exactly what each may use. */
const SESSION_WRITERS: Allowed[] = [
  {
    file: 'src/app/api/v1/deals/[dealId]/progress/route.ts',
    names: ['deal_move_cursor'],
    reason: 'The MD moves the rail cursor (PATCH /progress); the caller is the signed-in session.',
  },
  {
    file: 'src/app/api/v1/deals/[dealId]/rail/steps/[stepId]/skip/route.ts',
    names: ['rail_skip_step'],
    reason: 'The MD skips a rail step; the caller is the signed-in session.',
  },
  {
    file: 'src/app/api/v1/deals/[dealId]/rail/steps/[stepId]/route.ts',
    names: ['rail_remove_step'],
    reason: 'The MD removes a rail step; the caller is the signed-in session.',
  },
  {
    file: 'src/app/api/v1/deals/[dealId]/rail/steps/[stepId]/restore/route.ts',
    names: ['rail_restore_step'],
    reason: 'The MD restores a removed rail step; the caller is the signed-in session.',
  },
  {
    file: 'src/app/api/v1/deals/[dealId]/steps/[stepId]/route.ts',
    names: ['deal_step_save'],
    reason: 'A step save advances the cursor on completion (deal_step_save); the caller is the signed-in session.',
  },
  {
    file: 'src/app/api/v1/deals/from-discovery/route.ts',
    names: ['discovery_promote_candidate'],
    reason: 'Promotion opens the mandate for a candidate the signed-in MD chose (Gate 0).',
  },
  {
    file: 'src/lib/discovery/api.ts',
    names: ['discovery_set_station'],
    reason: 'The Set station dialog: a person confirms a station on a candidate, on their own session.',
  },
];

/** Operator scripts, run by hand against a development or seeded database; never by a request, the worker or an agent. */
const OPERATOR_SCRIPTS: Allowed[] = [
  {
    file: 'scripts/backfill-project-rail.ts',
    names: ['current_deal_step_id', 'current_step_seq', STEP_CURSOR],
    reason: 'Operator backfill: re-derives a deal\'s current step after the project rail changed shape.',
  },
  {
    file: 'scripts/seed-users.ts',
    names: ['current_deal_step_id', 'current_step_seq'],
    reason: 'Operator seed: puts the sandbox deals at their intended step.',
  },
  {
    file: 'scripts/seed-mock-scale.ts',
    names: ['current_step_seq'],
    reason: 'Operator seed: puts the scale-test deals at their entry step.',
  },
  {
    file: 'scripts/seed-demo-book.ts',
    names: ['deal_step_save'],
    reason: 'Local-only demo seed (assertLocalSupabase): completes the demo book\'s steps through the step route\'s own RPC.',
  },
];

export const ALLOWED: Allowed[] = [...SESSION_WRITERS, ...OPERATOR_SCRIPTS];

/**
 * Modules that mention a station RPC or a cursor column only to read or describe it. They must stay out of the list:
 * a change that makes one of them write turns this test red.
 */
export const READ_ONLY = [
  'src/lib/api/v1/access.ts',
  'src/lib/rail/dealRail.ts',
  'src/lib/discovery/extract/store.ts',
  'src/lib/mailboxAccess/agentSurfaces.ts',
  'scripts/preflight-db.ts',
  'src/components/rail/DealRail.tsx',
  'src/app/api/v1/deals/[dealId]/rail/route.ts',
  'src/app/api/v1/deals/route.ts',
  'worker/accept.ts',
  'worker/classify.ts',
  'worker/sync.ts',
];

const isStringLike = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

const nameOf = (node: ts.PropertyName): string | undefined =>
  ts.isIdentifier(node) || isStringLike(node) ? node.text : undefined;

const ASSIGNMENTS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/** The station RPC names and cursor writes a file makes, each once. */
export function stationWrites(text: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      for (const arg of node.arguments ?? []) {
        if (isStringLike(arg) && STATION_RPCS.has(arg.text)) found.add(arg.text);
      }
    } else if (ts.isPropertyAssignment(node)) {
      const name = nameOf(node.name);
      if (name !== undefined && CURSOR_COLUMNS.has(name)) found.add(name);
      if (name === 'status' && isStringLike(node.initializer) && node.initializer.text === 'current') found.add(STEP_CURSOR);
    } else if (ts.isShorthandPropertyAssignment(node)) {
      if (CURSOR_COLUMNS.has(node.name.text)) found.add(node.name.text);
    } else if (ts.isBinaryExpression(node) && ASSIGNMENTS.has(node.operatorToken.kind)) {
      const left = node.left;
      if (ts.isPropertyAccessExpression(left) && CURSOR_COLUMNS.has(left.name.text)) found.add(left.name.text);
      if (ts.isElementAccessExpression(left) && isStringLike(left.argumentExpression) && CURSOR_COLUMNS.has(left.argumentExpression.text)) {
        found.add(left.argumentExpression.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...found].sort();
}

/** A cheap pre-filter so the walk parses only files that could match. */
const MENTIONS = new RegExp(
  `${[...STATION_RPCS, ...CURSOR_COLUMNS].join('|')}|status\\s*:\\s*['"\`]current['"\`]`,
);

/** Every `file: name` that is not on the allow list, for the files given (path to text). */
export function violations(files: ReadonlyMap<string, string>, allowed: readonly Allowed[] = ALLOWED): string[] {
  const out: string[] = [];
  for (const [file, text] of files) {
    if (!MENTIONS.test(text)) continue;
    const permitted = new Set(allowed.find((entry) => entry.file === file)?.names ?? []);
    for (const name of stationWrites(text, file)) {
      if (!permitted.has(name)) out.push(`${file}: ${name}`);
    }
  }
  return out.sort();
}

const ROOTS = ['src', 'worker', 'scripts'];
const SOURCE_FILE = /\.(ts|tsx|mjs|js)$/;
const scanned = ROOTS.flatMap((root) => walk(root)).filter((file) => SOURCE_FILE.test(file));
const tree = new Map(scanned.map((file) => [file, readFileSync(file, 'utf8')] as const));

describe('no module outside the allow list reaches a station writer (R1)', () => {
  it('src/, worker/ and scripts/ hold no station RPC call and no cursor or override write but the listed ones', () => {
    expect(violations(tree)).toEqual([]);
  }, 60_000);

  it('scans the zones it is meant to: the worker, the discovery folders and the listed writers are all in the walk', () => {
    expect(tree.size).toBeGreaterThan(500);
    for (const file of [
      'worker/classify.ts',
      'worker/accept.ts',
      'src/lib/discovery/api.ts',
      ...ALLOWED.map((entry) => entry.file),
    ]) {
      expect(tree.has(file), file).toBe(true);
    }
    expect([...tree.keys()].some((file) => file.startsWith('src/lib/discovery/propose/'))).toBe(true);
    expect([...tree.keys()].some((file) => file.startsWith('src/lib/orchestration/'))).toBe(true);
  });

  it('every listed file still writes exactly the names it is listed for: a stale or broad entry fails', () => {
    for (const entry of ALLOWED) {
      expect(entry.reason.length, entry.file).toBeGreaterThan(20);
      expect(stationWrites(tree.get(entry.file)!, entry.file), entry.file).toEqual([...entry.names].sort());
    }
  });

  it('a module that only reads or describes a column or an RPC stays off the list and trips nothing', () => {
    for (const file of READ_ONLY) {
      expect(ALLOWED.some((entry) => entry.file === file), file).toBe(false);
      expect(stationWrites(tree.get(file)!, file), file).toEqual([]);
    }
  });

  it('the worker and the model-facing zones are not on the list', () => {
    const zones = [/^worker\//, /^src\/lib\/discovery\/(detect|propose|extract)\//, /^src\/lib\/orchestration\/agents\//];
    for (const entry of ALLOWED) {
      expect(zones.some((zone) => zone.test(entry.file)), entry.file).toBe(false);
    }
  });
});

describe('the fence catches a planted violation, and only a violation', () => {
  const plant = (file: string, text: string) => violations(new Map([[file, text]]));

  it.each([
    ['an RPC call in the worker', 'worker/evil.ts', "await db.rpc('discovery_set_station', { p_candidate: id });", ['worker/evil.ts: discovery_set_station']],
    ['an RPC name passed to a wrapper', 'src/lib/discovery/propose/evil.ts', "await station('deal_move_cursor', 4);", ['src/lib/discovery/propose/evil.ts: deal_move_cursor']],
    ['an override written on update', 'src/lib/discovery/extract/evil.ts', "await db.from('deal_candidates').update({ station_override_step_id: 'p2-s4' }).eq('id', id);", ['src/lib/discovery/extract/evil.ts: station_override_step_id']],
    ['a quoted key', 'src/lib/orchestration/agents/evil.ts', "await db.from('deals').update({ 'current_step_seq': 9 });", ['src/lib/orchestration/agents/evil.ts: current_step_seq']],
    ['a shorthand key', 'worker/evil.ts', 'const current_deal_step_id = 1; await db.from("deals").update({ current_deal_step_id });', ['worker/evil.ts: current_deal_step_id']],
    ['an assignment', 'scripts/evil.ts', 'position.current_step_seq = 3;', ['scripts/evil.ts: current_step_seq']],
    ['an element assignment', 'scripts/evil.ts', "position['station_override_correction_id'] = x;", ['scripts/evil.ts: station_override_correction_id']],
    ['a step marked current', 'worker/evil.ts', "await db.from('deal_steps').update({ status: 'current' }).eq('id', id);", [`worker/evil.ts: ${'deal_steps.status=current'}`]],
    ['a listed route using a name it is not listed for', 'src/app/api/v1/deals/[dealId]/progress/route.ts', "await admin.rpc('discovery_set_station', {});", ['src/app/api/v1/deals/[dealId]/progress/route.ts: discovery_set_station']],
    ['a listed file writing a column it is not listed for', 'src/lib/discovery/api.ts', 'await db.from("deal_candidates").update({ station_override_step_id: null });', ['src/lib/discovery/api.ts: station_override_step_id']],
  ])('%s', (_label, file, text, expected) => {
    expect(plant(file, text)).toEqual(expected);
  });

  it.each([
    ['a select string', "await db.from('deals').select('id, current_step_seq, current_deal_step_id');"],
    ['a read of a column', 'const seq = row.current_step_seq; const out = { seq: row.current_deal_step_id, step: row.station_override_step_id };'],
    ['a type', 'type Row = { station_override_step_id: string | null; current_step_seq: number };'],
    ['a comment naming an RPC', "// deal_move_cursor and discovery_set_station are called by the routes.\n/** rail_skip_step */"],
    ['a registry that lists an RPC', "export const SURFACES = { 'x.ts': { rpcs: ['discovery_promote_candidate'] } };"],
    ['a status other than current', "await db.from('deal_steps').update({ status: 'pending' });"],
    ['a comparison, not an assignment', 'if (row.current_step_seq === 4 && row.current_deal_step_id == null) go();'],
  ])('%s trips nothing', (_label, text) => {
    expect(plant('worker/ok.ts', text)).toEqual([]);
  });

  it('an allowed file with an allowed name passes', () => {
    expect(plant('src/lib/discovery/api.ts', "await db.rpc('discovery_set_station', {});")).toEqual([]);
  });

  it('a planted module in a real zone fails the whole-tree check', () => {
    const planted = new Map(tree);
    planted.set('worker/planted.ts', "export const move = (db: Db) => db.rpc('deal_move_cursor', { p_deal: 1 });");
    expect(violations(planted)).toEqual(['worker/planted.ts: deal_move_cursor']);
  }, 60_000);
});
