import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { DEV_TENANT_ID } from '@/lib/db/tenant';
import { dedupeObservations, normalizeMessage } from '@/lib/discovery/normalize';
import {
  listedTeamFirms,
  MODEL_PROPOSAL_TENANT_IDS,
  proposalGate,
  ProposalRefusedError,
  TEAM_PROPOSAL_FIRMS,
} from '@/lib/discovery/propose/gate';
import { PROPOSAL_MODEL } from '@/lib/discovery/propose/model';
import { proposeDeals } from '@/lib/discovery/propose/run';
import { routeByFirmRules } from '@/lib/discovery/route/firmRules';
import type { MailMessage } from '@/lib/discovery/source/types';
import type { GateEnv, ProcessorPath } from '@/lib/modelGateway/processorGate';

import { memoryProposalStore, passesFor } from '../helpers/memoryProposalStore';
import { proposeReplyDouble } from '../helpers/proposeReplyDouble';

// The verified path cannot be reached on the shipped processor constants, and no policy may be injected
// (tests/model-policy-injection-fence.test.ts), so lock 3 is tested by forcing the processor gate's answer.
const forced = vi.hoisted(() => ({ path: null as null | 'verified' }));
vi.mock('@/lib/modelGateway/processorGate', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/modelGateway/processorGate')>();
  return {
    ...real,
    assertProcessorAllowed: (tenantId: string, kind: 'gateway' | 'recorded', env?: GateEnv): ProcessorPath =>
      forced.path ?? real.assertProcessorAllowed(tenantId, kind, env),
  };
});

const PILOT = '11111111-2222-4333-8444-555555555555'; // fake: no real tenant id in any fixture
const LOCAL = { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:55521', NEXT_PUBLIC_APP_ENV: 'local' };
const LIVE_LOCAL = { ...LOCAL, DISCOVERY_PROPOSE_TRANSPORT: 'gateway' };
const HOSTED = { NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co', DISCOVERY_PROPOSE_TRANSPORT: 'gateway' };

const unrouted = () =>
  routeByFirmRules(
    dedupeObservations([
      {
        sourceId: 'src-1',
        providerItemId: 'p-1',
        item: normalizeMessage({
          id: 'p-1',
          internetMessageId: '<gate-1@harbourline.example>',
          conversationId: 'c-1',
          subject: 'Next steps',
          sentDateTime: '2026-03-02T10:00:00Z',
          from: { emailAddress: { name: 'Dana Fox', address: 'dana.fox@harbourline.example' } },
          toRecipients: [],
          ccRecipients: [],
          body: { contentType: 'text', content: 'The buyer wants a call on Thursday.' },
        } as MailMessage),
      },
    ]).items,
    { scope: 'unscoped' },
  );

/** Runs proposeDeals behind the given locks; returns what reached the model and the store. */
async function attempt(opts: { tenantId?: string; flagOn?: boolean; env?: GateEnv; kind?: 'gateway' | 'recorded' }) {
  const m = memoryProposalStore();
  const transport = proposeReplyDouble(() => ({ deal_related: false, p_deal: 0, deal: null, phase: null, p_phase: 0 }), {
    kind: opts.kind ?? 'gateway',
  });
  const result = await proposeDeals(unrouted(), {
    tenantId: opts.tenantId ?? DEV_TENANT_ID,
    runId: '0b9a1c3e-5d7f-4a2b-8c4d-6e8f0a1b2c3d',
    sourceId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    sources: passesFor(opts.tenantId ?? DEV_TENANT_ID, m.store),
    gate: { flagOn: opts.flagOn ?? true, env: opts.env ?? LIVE_LOCAL },
    transport,
    store: m.store,
  }).then(
    () => null,
    (e: unknown) => e,
  );
  return { error: result, sent: transport.sent.length, rows: m.rows().length, storeCalls: m.calls };
}

describe('proposalGate: every lock ships closed', () => {
  it('ships an empty, frozen tenant list', () => {
    expect(MODEL_PROPOSAL_TENANT_IDS).toEqual([]);
    expect(Object.isFrozen(MODEL_PROPOSAL_TENANT_IDS)).toBe(true);
  });

  it('opens for the dev tenant on a local stack, with the pinned model', () => {
    expect(proposalGate({ tenantId: DEV_TENANT_ID, transportKind: 'gateway', flagOn: true, env: LIVE_LOCAL })).toEqual({
      ok: true,
      path: 'synthetic',
      model: PROPOSAL_MODEL,
    });
    expect(proposalGate({ tenantId: DEV_TENANT_ID, transportKind: 'recorded', flagOn: true, env: LOCAL })).toMatchObject({
      ok: true,
      path: 'recorded',
    });
  });

  type Over = { tenantId?: string; flagOn?: boolean; env?: GateEnv; kind?: 'gateway' | 'recorded' };
  it.each<[string, Over, string]>([
    ['the flag is off', { flagOn: false }, 'flag_off'],
    ['the propose transport is not selected', { env: LOCAL }, 'transport_not_selected'],
    ['only the extract transport is selected', { env: { ...LOCAL, DISCOVERY_EXTRACT_TRANSPORT: 'gateway' } }, 'transport_not_selected'],
    ['the stack is not local', { env: HOSTED }, 'not_local'],
    ['the stack is prod', { env: { ...LIVE_LOCAL, NEXT_PUBLIC_APP_ENV: 'prod' } }, 'prod'],
    ['the tenant is not synthetic', { tenantId: PILOT }, 'tenant_not_synthetic'],
    ['a replay off loopback is not for a synthetic tenant', { tenantId: PILOT, kind: 'recorded', env: HOSTED }, 'recorded_not_synthetic'],
  ])('refuses when %s: no call, no row, the store untouched', async (_label, over, code) => {
    const input = {
      tenantId: over.tenantId ?? DEV_TENANT_ID,
      transportKind: over.kind ?? ('gateway' as const),
      flagOn: over.flagOn ?? true,
      env: over.env ?? LIVE_LOCAL,
    };
    expect(proposalGate(input)).toEqual({ ok: false, code });
    const run = await attempt({ ...over, kind: input.transportKind });
    expect(run.error).toBeInstanceOf(ProposalRefusedError);
    expect((run.error as ProposalRefusedError).code).toBe(code);
    expect(run).toMatchObject({ sent: 0, rows: 0, storeCalls: { settledKeys: 0, candidates: 0, saveProposal: 0 } });
  });
});

describe('TEAM_PROPOSAL_FIRMS: the reviewed half of the team switch ships empty (G-01 #173)', () => {
  it('ships an empty, frozen list, so no team inbox reaches a model while it is', () => {
    expect(TEAM_PROPOSAL_FIRMS).toEqual([]);
    expect(Object.isFrozen(TEAM_PROPOSAL_FIRMS)).toBe(true);
    expect(listedTeamFirms(PILOT)).toEqual([]);
    expect(listedTeamFirms(DEV_TENANT_ID)).toEqual([]);
  });

  it('names a tenant\'s firms only, once each, from the list it is given', () => {
    const FIRM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const FIRM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const list = [
      { tenantId: PILOT, firmCompanyId: FIRM_A },
      { tenantId: PILOT, firmCompanyId: FIRM_A },
      { tenantId: DEV_TENANT_ID, firmCompanyId: FIRM_B },
    ];
    expect(listedTeamFirms(PILOT, list)).toEqual([FIRM_A]);
    expect(listedTeamFirms(DEV_TENANT_ID, list)).toEqual([FIRM_B]);
    expect(listedTeamFirms('00000000-0000-4000-8000-000000000000', list)).toEqual([]);
  });
});

describe('proposalGate: lock 3 bites on the verified path', () => {
  it('refuses a tenant that is not listed, even with every other lock open', async () => {
    forced.path = 'verified';
    try {
      expect(proposalGate({ tenantId: PILOT, transportKind: 'gateway', flagOn: true, env: HOSTED })).toEqual({
        ok: false,
        code: 'tenant_not_listed',
      });
      const run = await attempt({ tenantId: PILOT, env: HOSTED });
      expect((run.error as ProposalRefusedError).code).toBe('tenant_not_listed');
      expect(run).toMatchObject({ sent: 0, rows: 0 });
      // A listed tenant passes, with the pinned model.
      expect(proposalGate({ tenantId: PILOT, transportKind: 'gateway', flagOn: true, env: HOSTED, tenantIds: [PILOT] })).toEqual({
        ok: true,
        path: 'verified',
        model: PROPOSAL_MODEL,
      });
    } finally {
      forced.path = null;
    }
  });

  it('still checks the flag before the processor gate', () => {
    forced.path = 'verified';
    try {
      expect(proposalGate({ tenantId: PILOT, transportKind: 'gateway', flagOn: false, env: HOSTED, tenantIds: [PILOT] })).toEqual({
        ok: false,
        code: 'flag_off',
      });
    } finally {
      forced.path = null;
    }
  });
});

describe('the team list is a test seam only (G-01 #173)', () => {
  const ROOTS = ['src', 'worker', 'scripts'];
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : files(p)) : /\.(ts|tsx|mts)$/.test(n) ? [p] : [];
    });
  const sources = ROOTS.flatMap((r) => files(join(process.cwd(), r))).map((p) => ({
    path: relative(process.cwd(), p).split(sep).join('/'),
    text: readFileSync(p, 'utf8'),
  }));

  it('no source, worker or script file sets teamFirmList: only tests may override the shipped list', () => {
    // A property being set (`teamFirmList: ...`, `teamFirmList,`); the type declaration (`teamFirmList?:`) and the
    // read in runOnce (`options.propose.teamFirmList`) are not.
    const offenders = sources.filter((f) => /\bteamFirmList\s*[:,]/.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('only classify.ts and the step ask for the shipped list, through listedTeamFirms', () => {
    const callers = sources.filter((f) => /\blistedTeamFirms\(/.test(f.text)).map((f) => f.path);
    // The step intersects what it is handed with the list again (review F8), so it asks too.
    expect(callers).toEqual(['src/lib/discovery/propose/gate.ts', 'src/lib/discovery/propose/step.ts', 'worker/classify.ts']);
  });
});

describe('the tenant list is a test seam only', () => {
  const ROOTS = ['src', 'worker', 'scripts'];
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : files(p)) : /\.(ts|tsx|mts)$/.test(n) ? [p] : [];
    });

  it('no source, worker or script file outside gate.ts passes tenantIds to the gate', () => {
    const offenders = ROOTS.flatMap((r) => files(join(process.cwd(), r)))
      .map((p) => relative(process.cwd(), p).split(sep).join('/'))
      .filter((p) => p !== 'src/lib/discovery/propose/gate.ts')
      .filter((p) => {
        const text = readFileSync(join(process.cwd(), p), 'utf8');
        return /\bproposalGate\b/.test(text) && /\btenantIds\b/.test(text);
      });
    expect(offenders).toEqual([]);
  });
});
