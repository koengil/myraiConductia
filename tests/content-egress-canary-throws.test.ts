// @vitest-environment node
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { GET as RAIL_GET } from '@/app/api/v1/deals/[dealId]/rail/route';
import { onRequestError } from '@/instrumentation';
import { requireApiUser } from '@/lib/api/v1/http';
import {
  listDealStepsWithDatarooms,
  loadDealByIdOrCode,
  provisionDataroomFolder,
  seedDataroomsForDeal,
  stepHasUpload,
} from '@/lib/dataroom/steps';
import { orderedSteps } from '@/lib/rail/dealRail';
import { captureConsole, type ConsoleCapture } from './helpers/consoleCapture';

/**
 * #331 canary, thrown messages (Phase 8a): a PostgREST message never survives
 * into a thrown error. Next prints an uncaught error's message and stack, so
 * what a throw carries is what Vercel stores. CANARY-331 is planted in the
 * database error's message, details and hint; it must not appear in the
 * rejection or in any console line, while the error's code does.
 */

const CANARY = 'CANARY-331';
const PG_ERROR = {
  code: '22P02',
  message: `${CANARY} invalid input syntax for type uuid: "Q3 board deck.pdf"`,
  details: `${CANARY} details`,
  hint: `${CANARY} hint`,
};

vi.mock('@/lib/api/v1/http', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/api/v1/http')>()),
  requireApiUser: vi.fn(),
}));

type Resp = { data: unknown; error: unknown; count?: number | null };

/** A chainable admin stub: each table answers one configured response, and every other table answers empty. */
function makeAdmin(tables: Record<string, Resp>): SupabaseClient {
  return {
    from(table: string) {
      const resp: Resp = tables[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'in', 'neq', 'insert', 'update', 'limit', 'order']) builder[m] = () => builder;
      builder.single = () => Promise.resolve(resp);
      builder.maybeSingle = () => Promise.resolve(resp);
      builder.then = (res: (v: Resp) => unknown) => Promise.resolve(resp).then(res);
      return builder;
    },
  } as unknown as SupabaseClient;
}

/** What an operator or a caller can read from a promise that rejects or resolves: the error as Next would print it. */
async function outcomeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    const value = await run();
    return value instanceof Response ? await value.text() : inspect(value, { depth: 8 });
  } catch (err) {
    return inspect(err, { depth: 8 });
  }
}

let capture: ConsoleCapture;

beforeEach(() => {
  vi.clearAllMocks();
  capture = captureConsole();
});

afterEach(() => {
  capture.restore();
});

describe('the rail GET over a failing deal lookup', () => {
  it('rejects without the database message (loadDealByIdOrCode is awaited without a catch)', async () => {
    const admin = makeAdmin({ deals: { data: null, error: PG_ERROR } });
    vi.mocked(requireApiUser).mockResolvedValue({ ok: true, admin, user: { id: 'u1', email: 'md@bank.dev' } } as never);
    const outcome = await outcomeOf(() => RAIL_GET(new Request('http://localhost/x'), { params: Promise.resolve({ dealId: 'not-a-uuid' }) }));
    expect(outcome).not.toContain(CANARY);
    expect(outcome).not.toContain('Q3 board deck');
    expect(outcome).toContain('22P02');
    expect(capture.output()).not.toContain(CANARY);
  });
});

describe('dataroom lookups over a failing database', () => {
  const STEP_ID = orderedSteps()[0].id;

  const CASES: Array<[string, () => Promise<unknown>]> = [
    ['loadDealByIdOrCode', () => loadDealByIdOrCode(makeAdmin({ deals: { data: null, error: PG_ERROR } }), 'PRJRA')],
    ['seedDataroomsForDeal (insert)', () => seedDataroomsForDeal(makeAdmin({ datarooms: { data: null, error: PG_ERROR } }), 'd1')],
    ['listDealStepsWithDatarooms (datarooms)', () => listDealStepsWithDatarooms(makeAdmin({ datarooms: { data: null, error: PG_ERROR } }), 'd1')],
    [
      'listDealStepsWithDatarooms (rail steps)',
      () => listDealStepsWithDatarooms(makeAdmin({ datarooms: { data: [], error: null }, deal_steps: { data: null, error: PG_ERROR } }), 'd1'),
    ],
    ['stepHasUpload (dataroom)', () => stepHasUpload(makeAdmin({ datarooms: { data: null, error: PG_ERROR } }), 'd1', STEP_ID)],
    [
      'stepHasUpload (documents)',
      () => stepHasUpload(makeAdmin({ datarooms: { data: { id: 'room-1' }, error: null }, documents: { data: null, error: PG_ERROR } }), 'd1', STEP_ID),
    ],
    ['provisionDataroomFolder (select)', () => provisionDataroomFolder(makeAdmin({ datarooms: { data: null, error: PG_ERROR } }), 'd1', STEP_ID, 'PRJRA')],
  ];

  it.each(CASES)('%s rejects with a code, not the database message', async (_label, run) => {
    const outcome = await outcomeOf(run);
    expect(outcome).not.toContain(CANARY);
    expect(outcome).not.toContain('Q3 board deck');
    expect(outcome).toContain('22P02');
    expect(capture.output()).not.toContain(CANARY);
  });
});

describe('a JSON.parse SyntaxError on mail text, thrown from a route (#474, thread T7)', () => {
  // A stand-in handler: every v1 route catches its own request.json(), so none lets this escape today.
  async function POST(request: Request): Promise<Response> {
    return new Response(JSON.stringify({ parsed: JSON.parse(await request.text()) as unknown }));
  }

  it("records that Next's print quotes the input, while the request_error line stays clean", async () => {
    let thrown: unknown = null;
    try {
      await POST(new Request('http://localhost/api/v1/x', { method: 'POST', body: 'Project Falcon' }));
    } catch (err) {
      thrown = err;
    }
    // T7, measured on Node 22: V8 quotes a short input whole (`Unexpected token 'P', "Project Falcon" is not
    // valid JSON`) and the first ten characters of a longer one. Next prints that message and stack as they
    // are, so this text reaches the platform's log. The fix belongs to T7, not to the logger.
    expect(inspect(thrown, { depth: 8 })).toContain('Project Falcon');

    await onRequestError(
      thrown,
      { path: '/api/v1/x', method: 'POST', headers: {} },
      { routerKind: 'App Router', routePath: '/api/v1/x', routeType: 'route', revalidateReason: undefined },
    );
    expect(capture.lines()).toEqual(['{"evt":"request_error","routeType":"route","method":"POST","errorClass":"SyntaxError"}']);
    expect(capture.output()).not.toContain('Falcon');
  });
});
