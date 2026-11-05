// @vitest-environment node
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The import fences in eslint.config.mjs, proven by linting a probe file at a
 * fenced path (the file need not exist: ESLint applies the config by path).
 * Each probe must raise no-restricted-imports; the same probe at an unfenced
 * path must not.
 */

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: process.cwd() });
}, 60_000);

async function restrictedImports(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(process.cwd(), file) });
  return result.messages
    .filter((m) => m.ruleId === 'no-restricted-imports')
    .map((m) => m.message);
}

const ADMIN_IMPORT = "import { createSupabaseAdminClient } from '@/lib/supabase/server';\nexport const x = createSupabaseAdminClient;\n";
const RELATIVE_ADMIN_IMPORT =
  "import { createSupabaseAdminClient } from '../../../../../lib/supabase/server';\nexport const x = createSupabaseAdminClient;\n";
const RAW_CLIENT =
  "import { createClient } from '@supabase/supabase-js';\nexport const x = createClient;\n";
const REQUIRE_API_USER = "import { requireApiUser } from '@/lib/api/v1/http';\nexport const x = requireApiUser;\n";
const SERVER_CLIENT = "import { createSupabaseServerClient } from '@/lib/supabase/server';\nexport const x = createSupabaseServerClient;\n";
const MODEL_IMPORTS = [
  "import { callModel } from '@/lib/modelGateway';\nexport const x = callModel;\n",
  "import { ANTHROPIC_MESSAGES_URL } from '@/lib/anthropic/headers';\nexport const x = ANTHROPIC_MESSAGES_URL;\n",
  "import { readIgnatiousConfig } from '@/lib/ignatious/config';\nexport const x = readIgnatiousConfig;\n",
  "import { fullScreenFields } from '@/lib/compliance/llm';\nexport const x = fullScreenFields;\n",
  "import { runLlmScreen } from '@/lib/compliance/llm';\nexport const x = runLlmScreen;\n",
  "import { jevRiskRead } from '@/lib/ai/jev';\nexport const x = jevRiskRead;\n",
  "import { jevRiskRead } from '../ai/jev';\nexport const x = jevRiskRead;\n",
  "import { jevCallAllowed } from '@/lib/compliance/secondOpinion';\nexport const x = jevCallAllowed;\n",
  "import { jevCallAllowed } from './secondOpinion';\nexport const x = jevCallAllowed;\n",
  "import Anthropic from '@anthropic-ai/sdk/resources/messages';\nexport const x = Anthropic;\n",
  "import { modelCallsAllowed } from '@/lib/ai/modelPolicy';\nexport const x = modelCallsAllowed;\n",
  "import { VERIFIED_MODEL_PROCESSORS } from '@/lib/ai/processorRules';\nexport const x = VERIFIED_MODEL_PROCESSORS;\n",
];
const DISCOVERY_IMPORT = "import { listCandidates } from '@/lib/discovery/api';\nexport const x = listCandidates;\n";
const GUARD_IMPORT = "import { assertMailboxAllowed } from '@/lib/mailboxAccess';\nexport const x = assertMailboxAllowed;\n";
const ACCESSOR_IMPORT =
  "import { readMailboxItemsForTool } from '@/lib/mailboxAccess/accessors';\nexport const x = readMailboxItemsForTool;\n";
const EVALS_IMPORTS = [
  "import { loadAnswerKey } from '../../../evals/deal-discovery/src/answerKey';\nexport const x = loadAnswerKey;\n",
  "import { score } from '../evals/deal-discovery/src/score.ts';\nexport const x = score;\n",
  "import { score } from 'evals/deal-discovery/src/score';\nexport const x = score;\n",
  "export * from '../../evals';\n",
];

describe('discovery routes cannot reach the service-role client', () => {
  it.each([
    'src/app/api/v1/discovery/candidates/probe.ts',
    'src/app/api/v1/discovery/mailbox-consent/route.ts',
    'src/app/api/v1/discovery/sites/route.ts',
    'src/app/api/v1/discovery/google-mailbox/route.ts',
    'src/app/api/v1/discovery/sources/[sourceId]/status/route.ts',
    'src/app/api/v1/discovery/sources/[sourceId]/restart/route.ts',
    'src/app/api/v1/discovery/team-mailboxes/route.ts',
    'src/app/api/v1/discovery/team-mailboxes/[teamMailboxId]/route.ts',
    'src/app/api/v1/discovery/team-mailboxes/[teamMailboxId]/members/route.ts',
    'src/app/api/v1/discovery/team-mailboxes/[teamMailboxId]/members/[userId]/route.ts',
    'src/app/api/v1/discovery/team-mailboxes/audit/route.ts',
    'src/app/api/v1/discovery/sources/[sourceId]/window/route.ts',
    'src/app/(authed)/discovery/probe.tsx',
    'src/lib/discovery/api.ts',
  ])('%s', async (file) => {
    expect(await restrictedImports(ADMIN_IMPORT, file)).toHaveLength(1);
    expect(await restrictedImports(REQUIRE_API_USER, file)).toHaveLength(1);
    expect(await restrictedImports(RAW_CLIENT, file)).toHaveLength(1);
  }, 30_000);

  it('catches a relative import of the admin client too', async () => {
    expect(
      await restrictedImports(RELATIVE_ADMIN_IMPORT, 'src/app/api/v1/discovery/candidates/probe.ts'),
    ).toHaveLength(1);
  });

  it('allows a type-only supabase-js import there, and the raw constructor elsewhere', async () => {
    const typeOnly = "import type { SupabaseClient } from '@supabase/supabase-js';\nexport type X = SupabaseClient;\n";
    expect(await restrictedImports(typeOnly, 'src/app/api/v1/discovery/candidates/probe.ts')).toEqual([]);
    expect(await restrictedImports(RAW_CLIENT, 'scripts/probe.ts')).toEqual([]);
  });

  it('still allows the user-scoped session client there, and the admin client elsewhere', async () => {
    expect(await restrictedImports(SERVER_CLIENT, 'src/app/api/v1/discovery/candidates/probe.ts')).toEqual([]);
    expect(await restrictedImports(ADMIN_IMPORT, 'src/app/api/v1/deals/probe.ts')).toEqual([]);
  });
});

describe('the classification zone makes no model calls', () => {
  it.each([
    'worker/classify.ts',
    'worker/sync.ts',
    'worker/boss.ts',
    'worker/jobLog.ts',
    'worker/teamMailbox.ts',
    'worker/accept.ts',
    'src/lib/graph/http.ts',
    'src/lib/graph/reader/probe.ts',
    'src/lib/graph/reader/extract/probe.mjs',
    'src/lib/discovery/normalize/probe.ts',
    'src/lib/discovery/route/probe.ts',
    'src/lib/discovery/discover/probe.ts',
    'src/lib/discovery/persist.ts',
    'src/lib/discovery/exclusion/probe.ts',
    'src/lib/google/reader/probe.ts',
    'src/lib/google/replay/probe.ts',
    'src/lib/compliance/screen.ts',
    'src/lib/compliance/screenIncoming.ts',
    'src/lib/compliance/forwardedBlock.ts',
  ])('%s', async (file) => {
    for (const code of MODEL_IMPORTS) {
      expect(await restrictedImports(code, file), code).toHaveLength(1);
    }
  }, 30_000);

  it('fences the Gmail reader like the Graph reader', async () => {
    expect(await restrictedImports(MODEL_IMPORTS[0], 'src/lib/google/reader/probe.ts')).toHaveLength(1);
  });

  it('does not fence code outside the zone', async () => {
    expect(await restrictedImports(MODEL_IMPORTS[1], 'src/lib/gate0/probe.ts')).toEqual([]);
  });
});

// Demo-only (#460; delete with #459): the proposal step's model side, and the two worker files that may hold it.
const PROPOSE_MODEL_SIDE = ['gate', 'run', 'store', 'step', 'model', 'parse', 'passes'].map(
  (name) => `import * as m from '@/lib/discovery/propose/${name}';\nexport const x = m;\n`,
);
const PROPOSE_READ_SIDE = ['group', 'key'].map((name) => `import * as m from '@/lib/discovery/propose/${name}';\nexport const x = m;\n`);

const proposeFence = async (code: string, file: string) =>
  (await restrictedImports(code, file)).filter((m) => m.includes("The demo proposal step's model side (#460)"));

describe('only worker/classify.ts and worker/sync.ts import the demo proposal step (#460)', () => {
  it.each([
    'src/lib/discovery/probe.ts',
    'src/lib/discovery/persist.ts',
    'src/lib/discovery/route/probe.ts',
    'src/lib/discovery/api.ts',
    'src/app/api/v1/discovery/model-proposals/route.ts',
    'src/app/(authed)/discovery/probe.tsx',
    'src/components/discovery/probe.tsx',
    'src/lib/ignatious/probe.ts',
    'src/lib/discovery/propose/group.ts',
    'worker/extract.ts',
    'worker/jobLog.ts',
    'worker/boss.ts',
    'scripts/probe.ts',
    'e2e/support/probe.ts',
  ])('%s cannot import its model side', async (file) => {
    // The propose fence's own message: an agent zone (Q21) also raises the discovery fence on the same import.
    for (const code of PROPOSE_MODEL_SIDE) expect(await proposeFence(code, file), code).toHaveLength(1);
  }, 60_000);

  it('a relative path is caught too', async () => {
    const relative = "import { proposeDeals } from '../propose/run';\nexport const x = proposeDeals;\n";
    expect(await proposeFence(relative, 'src/lib/discovery/extract/probe.ts')).toHaveLength(1);
  });

  it('worker/classify.ts and worker/sync.ts may import it, and still never the model gateway', async () => {
    for (const file of ['worker/classify.ts', 'worker/sync.ts']) {
      for (const code of PROPOSE_MODEL_SIDE) expect(await restrictedImports(code, file), code).toEqual([]);
      for (const code of MODEL_IMPORTS) expect(await restrictedImports(code, file), code).toHaveLength(1);
      for (const code of EVALS_IMPORTS) expect(await restrictedImports(code, file), code).toHaveLength(1);
    }
  }, 60_000);

  it('the folder imports itself by relative path, and tests import it freely', async () => {
    const own = "import { proposeDeals } from './run';\nexport const x = proposeDeals;\n";
    expect(await restrictedImports(own, 'src/lib/discovery/propose/step.ts')).toEqual([]);
    for (const code of PROPOSE_MODEL_SIDE) expect(await restrictedImports(code, 'tests/discovery/probe.test.ts')).toEqual([]);
  });

  it('the read side is importable anywhere, and is itself as model-free as the classification zone', async () => {
    for (const code of PROPOSE_READ_SIDE) {
      expect(await restrictedImports(code, 'src/lib/discovery/probe.ts')).toEqual([]);
      expect(await restrictedImports(code, 'src/app/api/v1/discovery/model-proposals/route.ts')).toEqual([]);
    }
    for (const file of ['src/lib/discovery/propose/group.ts', 'src/lib/discovery/propose/key.ts', 'src/lib/discovery/propose/read.ts', 'src/lib/discovery/propose/station.ts']) {
      expect(await restrictedImports(MODEL_IMPORTS[0], file)).toHaveLength(1);
    }
  });

  it('keeps the fences it shares a block with', async () => {
    expect(await restrictedImports(ADMIN_IMPORT, 'src/app/api/v1/discovery/model-proposals/route.ts')).toHaveLength(1);
    expect(await restrictedImports(DISCOVERY_IMPORT, 'src/lib/ignatious/probe.ts')).toHaveLength(1);
    expect(await restrictedImports(MODEL_IMPORTS[0], 'src/lib/discovery/persist.ts')).toHaveLength(1);
    expect(await restrictedImports(EVALS_IMPORTS[0], 'src/lib/discovery/probe.ts')).toHaveLength(1);
    // Scripts still may import the eval harness.
    expect(await restrictedImports(EVALS_IMPORTS[0], 'scripts/probe.ts')).toEqual([]);
  });
});

describe('agents and skills never read discovery data (Q21)', () => {
  it.each([
    'src/lib/ignatious/probe.ts',
    'src/lib/orchestration/probe.ts',
    'src/lib/skillRun/probe.ts',
    'src/lib/conductia/probe.ts',
    'src/app/v1/leads/[leadId]/probe/route.ts',
  ])('%s', async (file) => {
    expect(await restrictedImports(DISCOVERY_IMPORT, file)).toHaveLength(1);
  }, 30_000);

  it.each([
    'src/lib/orchestration/probe.ts',
    'src/lib/conductia/probe.ts',
    'src/app/v1/leads/[leadId]/probe/route.ts',
  ])('%s cannot import the guard or the accessors (Q21 unchanged, thread T7)', async (file) => {
    expect(await restrictedImports(GUARD_IMPORT, file)).toHaveLength(1);
    expect(await restrictedImports(ACCESSOR_IMPORT, file)).toHaveLength(1);
  }, 30_000);

  it('does not fence the accessor import outside the agent zones', async () => {
    expect(await restrictedImports(ACCESSOR_IMPORT, 'src/lib/search/probe.ts')).toEqual([]);
  });

  it('lets the discovery route itself import the helpers', async () => {
    expect(await restrictedImports(DISCOVERY_IMPORT, 'src/app/api/v1/discovery/candidates/probe.ts')).toEqual([]);
  });
});

async function readerFence(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(process.cwd(), file) });
  return result.messages
    .filter((m) => m.ruleId === '@typescript-eslint/no-restricted-imports')
    .map((m) => m.message);
}

const READER_IMPORTS = [
  "import { getContentSource } from '@/lib/graph/reader';\nexport const x = getContentSource;\n",
  "import { createFixtureContentSource } from '@/lib/graph/reader/fixture';\nexport const x = createFixtureContentSource;\n",
  "import { readGmail } from '@/lib/google/reader/mail';\nexport const x = readGmail;\n",
  "import { ConfidentialClientApplication } from '@azure/msal-node';\nexport const x = ConfidentialClientApplication;\n",
  "import { GoogleAuth } from 'google-auth-library';\nexport const x = GoogleAuth;\n",
  "import { claimReaderCapability } from '@/lib/discovery/source/capability';\nexport const x = claimReaderCapability;\n",
];

describe('only the mailbox guard imports a reader (#262)', () => {
  it.each([
    'worker/classify.ts',
    'worker/sync.ts',
    'worker/jobLog.ts',
    'scripts/probe.ts',
    'src/app/v1/leads/[leadId]/probe/route.ts',
    'src/app/api/v1/discovery/probe/route.ts',
    'src/lib/discovery/probe.ts',
    'src/lib/search/probe.ts',
    'src/lib/orchestration/agents/probe.ts',
  ])('%s', async (file) => {
    for (const code of READER_IMPORTS) expect(await readerFence(code, file), code).toHaveLength(1);
  }, 60_000);

  it('catches relative paths too', async () => {
    expect(await readerFence("import { getContentSource } from '../src/lib/graph/reader';\nexport const x = getContentSource;\n", 'scripts/probe.ts')).toHaveLength(1);
    expect(await readerFence("import { getContentSource } from '../graph/reader';\nexport const x = getContentSource;\n", 'src/lib/search/probe.ts')).toHaveLength(1);
  });

  it('allows type-only imports, the guard module and the reader itself', async () => {
    expect(await readerFence("import type { SourceRow } from '@/lib/graph/reader';\nexport type X = SourceRow;\n", 'worker/probe.ts')).toEqual([]);
    expect(await readerFence(READER_IMPORTS[0], 'src/lib/mailboxAccess/probe.ts')).toEqual([]);
    expect(await readerFence(READER_IMPORTS[1], 'src/lib/graph/reader/probe.ts')).toEqual([]);
    expect(await readerFence(READER_IMPORTS[5], 'src/lib/graph/reader/probe.ts')).toEqual([]);
    expect(await readerFence(READER_IMPORTS[5], 'src/lib/mailboxAccess/probe.ts')).toEqual([]);
    expect(await readerFence("import type { ReaderCapability } from '@/lib/discovery/source/capability';\nexport type X = ReaderCapability;\n", 'worker/probe.ts')).toEqual([]);
  });

  it('keeps fences A, B and C firing on files the reader fence also matches', async () => {
    expect(await restrictedImports(ADMIN_IMPORT, 'src/app/api/v1/discovery/candidates/probe.ts')).toHaveLength(1);
    expect(await restrictedImports(MODEL_IMPORTS[0], 'worker/classify.ts')).toHaveLength(1);
    expect(await restrictedImports(MODEL_IMPORTS[0], 'src/lib/mailboxAccess/probe.ts')).toHaveLength(1);
    expect(await restrictedImports(DISCOVERY_IMPORT, 'src/lib/orchestration/probe.ts')).toHaveLength(1);
  });

  it('lints .mjs files too: the typescript-eslint plugin is registered for them (probed on 8.59.4)', async () => {
    // Pins the Phase 5 first check. If this ever stops firing, narrow the glob in
    // eslint.config.mjs and rely on tests/mailbox-reader-fence.test.ts for JS.
    expect(await readerFence("import { getContentSource } from '../src/lib/graph/reader/index.ts';\nexport const x = getContentSource;\n", 'scripts/probe.mjs')).toHaveLength(1);
  });
});

describe('the app never imports the eval harness (Q15)', () => {
  it.each([
    // Unfenced by any other block.
    'src/lib/scoring/probe.ts',
    'src/components/discovery/probe.tsx',
    'src/app/(authed)/projects/probe.tsx',
    'worker/extract.ts',
    // Each of the three discovery blocks keeps the fence too.
    'src/app/api/v1/discovery/candidates/probe.ts',
    'src/lib/discovery/api.ts',
    'worker/classify.ts',
    'src/lib/discovery/route/probe.ts',
    'src/lib/graph/reader/extract/probe.mjs',
    'src/lib/ignatious/probe.ts',
  ])('%s', async (file) => {
    for (const code of EVALS_IMPORTS) {
      expect(await restrictedImports(code, file), code).toHaveLength(1);
    }
  }, 30_000);

  it('keeps the other fences where it adds its own', async () => {
    expect(await restrictedImports(ADMIN_IMPORT, 'src/lib/discovery/api.ts')).toHaveLength(1);
    expect(await restrictedImports(MODEL_IMPORTS[0], 'worker/classify.ts')).toHaveLength(1);
    expect(await restrictedImports(DISCOVERY_IMPORT, 'src/lib/skillRun/probe.ts')).toHaveLength(1);
  });

  it('does not fence scripts or tests, and does not catch a name that merely contains "evals"', async () => {
    expect(await restrictedImports(EVALS_IMPORTS[0], 'scripts/probe.ts')).toEqual([]);
    expect(await restrictedImports(EVALS_IMPORTS[0], 'tests/probe.test.ts')).toEqual([]);
    const lookalike = "import { x } from '@/lib/retrievals/index';\nexport const y = x;\n";
    expect(await restrictedImports(lookalike, 'src/lib/scoring/probe.ts')).toEqual([]);
  });
});

// A raw fetch to /api/v1 in feature UI warns (ARCHITECTURE.md §2): apiV1 throws on
// a non-2xx response; fetch resolves on one.
describe('raw /api/v1 fetches in feature UI', () => {
  async function rawFetchWarnings(code: string, file: string) {
    const [result] = await eslint.lintText(code, { filePath: join(process.cwd(), file) });
    expect(result.messages.filter((m) => m.fatal)).toEqual([]);
    return result.messages.filter((m) => m.ruleId === 'no-restricted-syntax' && /apiV1/.test(m.message));
  }
  const CALLS = 'export function a(id: string) {\n  void fetch("/api/v1/deals");\n  void fetch(`/api/v1/deals/${id}`);\n  void fetch("/other");\n}\n';

  it('warns on the string and template forms, not on other paths', async () => {
    const found = await rawFetchWarnings(CALLS, 'src/components/rail/Probe.tsx');
    expect(found.map((m) => [m.line, m.severity])).toEqual([[2, 1], [3, 1]]);
  });

  it('stays quiet in route handlers and the client itself', async () => {
    expect(await rawFetchWarnings(CALLS, 'src/app/api/v1/deals/route.ts')).toEqual([]);
    expect(await rawFetchWarnings(CALLS, 'src/lib/api/v1Client.ts')).toEqual([]);
  });
});
