import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Prelaunch audit PL-02 (D-0), proven against a REAL database: a run started
 * by firm A cannot read or write firm B's lead through the /v1 agent seam.
 *
 * The unit tests (tests/conductia-seam-tenant.test.ts) pin the gate over fake
 * Supabase clients. This file drives the real /v1 handlers in-process, through
 * the real requireConductiaLead and loadConductiaLead, against real rows, and
 * re-reads firm B's rows after every refused write. A refusal alone shows the
 * handler said no; the re-read shows nothing was written.
 *
 * The deal path (lead id = deals.code), the company path (lead id =
 * companies.id) and the tenant-scoped personas. Two layers on the deal path:
 * the tenant wall in isolation (a synthetic token that is certain to reach
 * it), then the tokens a real firm A run holds, deal-scoped and
 * company-scoped, each pinned to the wall that stops it. The shared instance
 * key is refused on both paths.
 *
 * What is real: the route handlers, the token signing and verification, the
 * gates, Postgres. Nothing is mocked. The Ignatious config is stubbed through
 * env because the seam only needs it to exist, never to be reached.
 *
 * Every row is created for this run (random tenants, RUN-suffixed codes) and
 * deleted by id in afterAll, children first. None of these routes writes an
 * audit_log row, so unlike phase1.e2e.test.ts there is no WORM residue.
 */

import { createClient } from '@supabase/supabase-js';

import { GET as getLead } from '@/app/v1/leads/[leadId]/route';
import {
  GET as listDocuments,
  POST as fileDocument,
} from '@/app/v1/leads/[leadId]/documents/route';
import { POST as addNote } from '@/app/v1/leads/[leadId]/notes/route';
import { PATCH as patchFields } from '@/app/v1/leads/[leadId]/fields/route';
import { GET as listPersonas } from '@/app/v1/personas/route';
import { GET as getPersonaRoute, PATCH as patchPersonaRoute } from '@/app/v1/personas/[personaId]/route';
import { POST as linkPersonaRoute } from '@/app/v1/personas/[personaId]/links/route';
import { emptyRecord } from '@/lib/conductia/lead';
import {
  digitalTwinScopes,
  mdBriefingScopes,
  mintTriggerToken,
  presearchScopes,
  sourceIntelligenceScopes,
} from '@/lib/ignatious/jwt';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  throw new Error(
    'Integration suite needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY ' +
      '(local `supabase start` stack or the -dev project).',
  );
}
const db = createClient(url, secret, { auth: { persistSession: false } });

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** The Ignatious control-plane handle: one constant per deployment, not a firm. */
const HANDLE = 'tn_demo';

type Firm = {
  label: 'A' | 'B';
  tenantId: string;
  bankId: string;
  targetId: string;
  dealId: string;
  /** The deal path's lead id. */
  code: string;
  /** Every lead_documents id on this firm's lead, seeded or filed by a control. */
  documentIds: string[];
  /** A company with no deal: the company path's lead id (companies.id). */
  companyLeadId: string;
  /** Every lead_documents id on this firm's company-path lead. */
  companyDocumentIds: string[];
  /** This firm's lead_personas.id, conductia_tenant_id-scoped to it. */
  personaId: string;
};

function blankFirm(label: Firm['label']): Firm {
  return {
    label,
    tenantId: crypto.randomUUID(),
    bankId: '',
    targetId: '',
    dealId: '',
    code: `PL02${label}-${RUN.toUpperCase()}`,
    documentIds: [],
    companyLeadId: '',
    companyDocumentIds: [],
    personaId: '',
  };
}

const firms = { A: blankFirm('A'), B: blankFirm('B') };

/**
 * A deal firm B owns whose TARGET company sits under firm A's tenant: the case
 * where resolveLeadCompany's tenant (the target's) and the owner's
 * (deals.tenant_id) diverge. Onboarding can produce it, since a target of type
 * `bank` is minted its own tenant.
 */
const split = { code: `PL02S-${RUN.toUpperCase()}`, dealId: '', targetId: '' };

/**
 * The real agent grants that call these routes. md-briefing reads the lead and
 * reads and files documents; source-intelligence writes notes and fields.
 * Using each route's real grant means the scope check passes and only the
 * tenant wall can refuse.
 */
const AGENTS = {
  'md-briefing': mdBriefingScopes(),
  presearch: presearchScopes(),
  'source-intelligence': sourceIntelligenceScopes(),
  'digital-twin': digitalTwinScopes(),
} as const;
type AgentName = keyof typeof AGENTS;

/**
 * A token minted for `tenant`, naming `leadId` as its dealId claim. On the
 * cross-firm cases the claim names FIRM B's deal code, so claimBindsToLead
 * passes (claim === path) and the request reaches the tenant comparison. A
 * token naming A's own code would be refused one wall earlier, on dealId.
 */
function tokenFor(tenant: Firm, leadId: string, agent: AgentName): string {
  return mintTriggerToken({
    agentName: agent,
    dealId: leadId,
    conductiaTenantId: tenant.tenantId,
    scopes: AGENTS[agent],
  });
}

/** A seam callback as Ignatious sends it: bearer token plus the four x-conductia-* headers. */
function seamRequest(
  path: string,
  bearer: string,
  leadId: string,
  agent: AgentName,
  init: { method?: string; body?: unknown } = {},
): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${bearer}`,
      'x-conductia-tenant-id': HANDLE,
      'x-conductia-lead-id': leadId,
      'x-conductia-agent-name': agent,
      'x-conductia-run-id': `run_pl02_${RUN}`,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const ctx = (leadId: string) => ({ params: Promise.resolve({ leadId }) });
const personaCtx = (personaId: string) => ({ params: Promise.resolve({ personaId }) });

/** Firm A's `agent` token, presented on `target`'s deal-path lead. */
function asFirmA(target: Firm, agent: AgentName) {
  return tokenFor(firms.A, target.code, agent);
}

/**
 * Firm A's `agent` token, naming `target`'s COMPANY-path lead id as the claim
 * and presented on that same path: claim === path, so claimBindsToLead passes
 * trivially and the request reaches the tenant wall, mirroring `asFirmA` for
 * the company path.
 */
function asFirmACompany(target: Firm, agent: AgentName) {
  return tokenFor(firms.A, target.companyLeadId, agent);
}

/**
 * A digital-twin token for the persona routes, naming the firm's own company
 * id as a real digital-twin run mints it. There is no lead in a persona path:
 * the dealId claim is bound to the persona's links instead, for reads and
 * writes alike.
 */
function personaToken(firm: Firm) {
  return tokenFor(firm, firm.targetId, 'digital-twin');
}

/**
 * The tokens a real firm A run holds, as the mint sites stamp them. A deal run
 * (md-briefing, deal bench) names A's deal code. A company run (presearch,
 * debrief, twins) names A's COMPANY id, which claimBindsToLead compares with
 * the target company of the path's deal, so B's deal refuses it on dealId.
 */
function realDealToken(firm: Firm, agent: AgentName): string {
  return tokenFor(firm, firm.code, agent);
}
function realCompanyToken(firm: Firm, agent: AgentName): string {
  return tokenFor(firm, firm.targetId, agent);
}

/**
 * The reason the lead gate logged for its latest refusal, then forget it, so
 * a later assertion cannot be satisfied by an earlier request's log line.
 */
function takeDenyReason(): string | undefined {
  const warn = vi.mocked(console.warn);
  const denies = warn.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith('[conductia-seam] {'))
    .map((line) => JSON.parse(line.slice('[conductia-seam] '.length)) as { reason?: string });
  warn.mockClear();
  return denies.at(-1)?.reason;
}

/** What the lead gate answers for a lead that does not exist. */
function missingLeadBody(leadId: string) {
  return {
    error: {
      code: 'not_found',
      message: `No deal for lead ${leadId}.`,
      alert: false,
      retryable: false,
      detail: { leadId },
    },
  };
}

/**
 * A lead-gate refusal. The dealId binding and the tenant wall both answer
 * exactly as a missing lead would, so no token can tell another firm's deal
 * code from an unused one. The response cannot say which wall fired, so the
 * server log's reason does, and a refusal at the wrong wall fails the test.
 * Every refused row has a 200 control on the same kind of lead.
 */
async function expectMissingLeadRefusal(
  res: Response,
  leadId: string,
  reason: 'binding' | 'tenant_binding',
): Promise<void> {
  expect(res.status).toBe(404);
  const body = (await res.json()) as unknown;
  expect(body).toEqual(missingLeadBody(leadId));
  expect(JSON.stringify(body)).not.toContain(firms.B.tenantId);
  expect(takeDenyReason()).toBe(reason);
}

/** The tenant wall: the lead exists, at another firm. */
async function expectTenantRefusal(res: Response, leadId: string): Promise<void> {
  await expectMissingLeadRefusal(res, leadId, 'tenant_binding');
}

/** The dealId binding: the token names a different deal than the path. */
async function expectBindingRefusal(res: Response, leadId: string): Promise<void> {
  await expectMissingLeadRefusal(res, leadId, 'binding');
}

/** The shared instance key: refused on every lead route, before any lookup. */
async function expectApiKeyRefusal(res: Response): Promise<void> {
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe('authentication');
}

async function readIntel(leadId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await db.from('lead_intel').select('*').eq('lead_id', leadId).maybeSingle();
  if (error) throw new Error(`lead_intel read failed: ${error.message}`);
  return data as Record<string, unknown> | null;
}

async function readDocuments(leadId: string): Promise<Record<string, unknown>[]> {
  const { data, error } = await db
    .from('lead_documents')
    .select('*')
    .eq('lead_id', leadId)
    .order('id');
  if (error) throw new Error(`lead_documents read failed: ${error.message}`);
  return (data ?? []) as Record<string, unknown>[];
}

async function readPersona(personaId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await db.from('lead_personas').select('*').eq('id', personaId).maybeSingle();
  if (error) throw new Error(`lead_personas read failed: ${error.message}`);
  return data as Record<string, unknown> | null;
}

/** Firm B's rows exactly as seeded, for the after-the-call comparisons. */
const seededB: {
  intel: Record<string, unknown> | null;
  documents: Record<string, unknown>[];
  companyIntel: Record<string, unknown> | null;
  companyDocuments: Record<string, unknown>[];
  persona: Record<string, unknown> | null;
} = {
  intel: null,
  documents: [],
  companyIntel: null,
  companyDocuments: [],
  persona: null,
};

async function seedFirm(firm: Firm): Promise<void> {
  const { data: companies, error: companyError } = await db
    .from('companies')
    .insert([
      { tenant_id: firm.tenantId, name: `PL02 Seam Bank ${firm.label} ${RUN}`, type: 'bank' },
      { tenant_id: firm.tenantId, name: `PL02 Seam Target ${firm.label} ${RUN}`, type: 'target' },
    ])
    .select('id, type');
  if (companyError || !companies) throw new Error(`company seed failed: ${companyError?.message}`);
  firm.bankId = companies.find((row) => row.type === 'bank')?.id as string;
  firm.targetId = companies.find((row) => row.type === 'target')?.id as string;

  const { data: deal, error: dealError } = await db
    .from('deals')
    .insert({
      tenant_id: firm.tenantId,
      code: firm.code,
      codename: `PL02 SEAM ${firm.label} ${RUN.toUpperCase()}`,
      bank_id: firm.bankId,
    })
    .select('id')
    .single();
  if (dealError || !deal) throw new Error(`deal seed failed: ${dealError?.message}`);
  firm.dealId = deal.id as string;

  const { error: partyError } = await db
    .from('deal_parties')
    .insert({ deal_id: firm.dealId, company_id: firm.targetId, party_role: 'target' });
  if (partyError) throw new Error(`deal party seed failed: ${partyError.message}`);

  const record = emptyRecord();
  record.clientGoals = {
    ...record.clientGoals,
    whySelling: `Firm ${firm.label} seed ${RUN}` as never,
  };
  const { error: intelError } = await db.from('lead_intel').insert({
    lead_id: firm.code,
    tenant_id: HANDLE,
    company_id: firm.targetId,
    version: 1,
    fields: record,
    notes: [
      {
        noteId: `note_seed_${firm.label}_${RUN}`,
        title: `Firm ${firm.label} seeded note`,
        body: `Seeded for PL-02 run ${RUN}.`,
      },
    ],
  });
  if (intelError) throw new Error(`lead_intel seed failed: ${intelError.message}`);

  const documentId = `doc_pl02_${firm.label}_${RUN}`;
  const { error: documentError } = await db.from('lead_documents').insert({
    id: documentId,
    tenant_id: HANDLE,
    lead_id: firm.code,
    company_id: firm.targetId,
    title: `Firm ${firm.label} seeded brief`,
    document_type: 'md_brief',
    folder: 'md-brief',
    kind: 'memo',
    text_content: `Firm ${firm.label} confidential brief, run ${RUN}.`,
    version: 1,
  });
  if (documentError) throw new Error(`lead_documents seed failed: ${documentError.message}`);
  firm.documentIds.push(documentId);

  // The company path: a company with no deal at all (companies.type
  // 'client'), so `loadDealByIdOrCode` never matches it and
  // `loadConductiaLead` falls through to `loadConductiaLeadFromCompany`.
  const { data: companyLead, error: companyLeadError } = await db
    .from('companies')
    .insert({ tenant_id: firm.tenantId, name: `PL02 Seam Company Lead ${firm.label} ${RUN}`, type: 'client' })
    .select('id')
    .single();
  if (companyLeadError || !companyLead) {
    throw new Error(`company-lead seed failed: ${companyLeadError?.message}`);
  }
  firm.companyLeadId = companyLead.id as string;

  const companyRecord = emptyRecord();
  companyRecord.clientGoals = {
    ...companyRecord.clientGoals,
    whySelling: `Firm ${firm.label} company seed ${RUN}` as never,
  };
  const { error: companyIntelError } = await db.from('lead_intel').insert({
    lead_id: firm.companyLeadId,
    tenant_id: HANDLE,
    company_id: firm.companyLeadId,
    version: 1,
    fields: companyRecord,
    notes: [
      {
        noteId: `note_seed_company_${firm.label}_${RUN}`,
        title: `Firm ${firm.label} seeded company note`,
        body: `Company-path seed for PL-02 run ${RUN}.`,
      },
    ],
  });
  if (companyIntelError) throw new Error(`company lead_intel seed failed: ${companyIntelError.message}`);

  const companyDocumentId = `doc_pl02_company_${firm.label}_${RUN}`;
  const { error: companyDocumentError } = await db.from('lead_documents').insert({
    id: companyDocumentId,
    tenant_id: HANDLE,
    lead_id: firm.companyLeadId,
    company_id: firm.companyLeadId,
    title: `Firm ${firm.label} seeded company brief`,
    document_type: 'md_brief',
    folder: 'md-brief',
    kind: 'memo',
    text_content: `Firm ${firm.label} confidential company brief, run ${RUN}.`,
    version: 1,
  });
  if (companyDocumentError) {
    throw new Error(`company lead_documents seed failed: ${companyDocumentError.message}`);
  }
  firm.companyDocumentIds.push(companyDocumentId);

  // A persona linked to the firm's target company: the lead a digital-twin
  // run's token names, so that run reads and writes it.
  const personaId = `per_pl02_${firm.label}_${RUN}`;
  const { error: personaError } = await db.from('lead_personas').insert({
    id: personaId,
    tenant_id: HANDLE,
    conductia_tenant_id: firm.tenantId,
    name: `Firm ${firm.label} Persona ${RUN}`,
    title: 'Operating Partner',
    organization: `PL02 Seam Target ${firm.label} ${RUN}`,
    type: 'contact',
    tags: [],
    body: `Seeded persona for PL-02 run ${RUN}.`,
    version: 1,
    authored_by: 'agent',
    links: [{ tenantId: HANDLE, leadId: firm.targetId, contactId: `contact_pl02_${firm.label}_${RUN}` }],
    evidence: [],
    history: [],
  });
  if (personaError) throw new Error(`lead_personas seed failed: ${personaError.message}`);
  firm.personaId = personaId;
}

async function seedSplitDeal(): Promise<void> {
  const { data: target, error: targetError } = await db
    .from('companies')
    .insert({ tenant_id: firms.A.tenantId, name: `PL02 Split Target ${RUN}`, type: 'target' })
    .select('id')
    .single();
  if (targetError || !target) throw new Error(`split target seed failed: ${targetError?.message}`);
  split.targetId = target.id as string;

  const { data: deal, error: dealError } = await db
    .from('deals')
    .insert({
      tenant_id: firms.B.tenantId,
      code: split.code,
      codename: `PL02 SPLIT ${RUN.toUpperCase()}`,
      bank_id: firms.B.bankId,
    })
    .select('id')
    .single();
  if (dealError || !deal) throw new Error(`split deal seed failed: ${dealError?.message}`);
  split.dealId = deal.id as string;

  const { error: partyError } = await db
    .from('deal_parties')
    .insert({ deal_id: split.dealId, company_id: split.targetId, party_role: 'target' });
  if (partyError) throw new Error(`split deal party seed failed: ${partyError.message}`);
}

beforeAll(async () => {
  vi.stubEnv('IGNATIOUS_CONTROL_PLANE_URL', 'http://localhost:4111');
  vi.stubEnv('IGNATIOUS_API_KEY', `pl02-key-${RUN}`);
  vi.stubEnv('IGNATIOUS_TENANT_ID', HANDLE);
  vi.stubEnv('CONDUCTIA_TRIGGER_TOKEN_SECRET', `pl02-secret-${RUN}-${crypto.randomUUID()}`);
  vi.stubEnv('CONDUCTIA_TRIGGER_TOKEN_MODE', 'enforce');
  // The seam logs every accept and deny; keep the run output readable.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  await seedFirm(firms.A);
  await seedFirm(firms.B);
  await seedSplitDeal();
  seededB.intel = await readIntel(firms.B.code);
  seededB.documents = await readDocuments(firms.B.code);
  seededB.companyIntel = await readIntel(firms.B.companyLeadId);
  seededB.companyDocuments = await readDocuments(firms.B.companyLeadId);
  seededB.persona = await readPersona(firms.B.personaId);
  expect(seededB.intel).not.toBeNull();
  expect(seededB.documents).toHaveLength(1);
  expect(seededB.companyIntel).not.toBeNull();
  expect(seededB.companyDocuments).toHaveLength(1);
  expect(seededB.persona).not.toBeNull();
});

// Each test reads only its own requests' deny reasons.
beforeEach(() => {
  vi.mocked(console.warn).mockClear();
});

afterAll(async () => {
  // Children first, every delete keyed on an id this run created. Each step is
  // best-effort so one failure does not strand the rows after it.
  const step = async (label: string, run: () => PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await run();
    if (error) console.error(`[pl02 cleanup] ${label}: ${error.message}`);
  };
  if (split.dealId) {
    await step('split deal_parties', () => db.from('deal_parties').delete().eq('deal_id', split.dealId));
    await step('split deal', () => db.from('deals').delete().eq('id', split.dealId));
  }
  if (split.targetId) {
    await step('split target', () => db.from('companies').delete().eq('id', split.targetId));
  }
  for (const firm of Object.values(firms)) {
    // Children first: persona rows carry no foreign key to a lead, so they are
    // independent of everything below, but they are still deleted before the
    // companies they are scoped to.
    if (firm.personaId) {
      await step(`lead_personas ${firm.label}`, () =>
        db.from('lead_personas').delete().eq('id', firm.personaId),
      );
    }
    // A write that slipped past an assertion would still carry this run's
    // conductia_tenant_id; sweep it too so a failing run leaves nothing behind.
    await step(`lead_personas by tenant ${firm.label}`, () =>
      db.from('lead_personas').delete().eq('conductia_tenant_id', firm.tenantId),
    );

    if (firm.documentIds.length > 0) {
      await step(`lead_documents ${firm.label}`, () =>
        db.from('lead_documents').delete().in('id', firm.documentIds),
      );
    }
    if (firm.companyDocumentIds.length > 0) {
      await step(`company lead_documents ${firm.label}`, () =>
        db.from('lead_documents').delete().in('id', firm.companyDocumentIds),
      );
    }
    // A write that slipped past an assertion would carry this run's unique
    // lead code; sweep it too so a failing run still leaves nothing behind.
    await step(`lead_documents by lead ${firm.label}`, () =>
      db.from('lead_documents').delete().eq('lead_id', firm.code),
    );
    if (firm.companyLeadId) {
      await step(`lead_documents by company lead ${firm.label}`, () =>
        db.from('lead_documents').delete().eq('lead_id', firm.companyLeadId),
      );
    }
    await step(`lead_intel ${firm.label}`, () =>
      db.from('lead_intel').delete().eq('lead_id', firm.code),
    );
    if (firm.companyLeadId) {
      await step(`company lead_intel ${firm.label}`, () =>
        db.from('lead_intel').delete().eq('lead_id', firm.companyLeadId),
      );
    }
    if (firm.dealId) {
      await step(`deal_parties ${firm.label}`, () =>
        db.from('deal_parties').delete().eq('deal_id', firm.dealId),
      );
      await step(`deals ${firm.label}`, () => db.from('deals').delete().eq('id', firm.dealId));
    }
    const companyIds = [firm.targetId, firm.bankId, firm.companyLeadId].filter(Boolean);
    if (companyIds.length > 0) {
      await step(`companies ${firm.label}`, () => db.from('companies').delete().in('id', companyIds));
    }
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("deal path: firm A's signed token on firm B's deal is refused at the tenant wall", () => {
  it('GET /v1/leads/[leadId]: refused for B, 200 for A', async () => {
    const B = firms.B;
    const refused = await getLead(
      seamRequest(`/v1/leads/${B.code}`, asFirmA(B, 'md-briefing'), B.code, 'md-briefing'),
      ctx(B.code),
    );
    await expectTenantRefusal(refused, B.code);

    const A = firms.A;
    const allowed = await getLead(
      seamRequest(`/v1/leads/${A.code}`, asFirmA(A, 'md-briefing'), A.code, 'md-briefing'),
      ctx(A.code),
    );
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as {
      lead: { leadId: string; version: number; record: { clientGoals: { whySelling: string } } };
    };
    expect(body.lead.leadId).toBe(A.code);
    expect(body.lead.record.clientGoals.whySelling).toBe(`Firm A seed ${RUN}`);
  });

  it('GET /v1/leads/[leadId]/documents: refused for B, 200 for A with only the A documents', async () => {
    const B = firms.B;
    const refused = await listDocuments(
      seamRequest(`/v1/leads/${B.code}/documents`, asFirmA(B, 'md-briefing'), B.code, 'md-briefing'),
      ctx(B.code),
    );
    await expectTenantRefusal(refused, B.code);

    const A = firms.A;
    const allowed = await listDocuments(
      seamRequest(`/v1/leads/${A.code}/documents`, asFirmA(A, 'md-briefing'), A.code, 'md-briefing'),
      ctx(A.code),
    );
    expect(allowed.status).toBe(200);
    const { documents } = (await allowed.json()) as { documents: { documentId: string }[] };
    const ids = documents.map((doc) => doc.documentId);
    expect(ids).toContain(A.documentIds[0]);
    expect(ids).not.toContain(B.documentIds[0]);
  });

  it('POST /v1/leads/[leadId]/notes: refused for B and the B lead_intel is unchanged; 200 for A', async () => {
    const note = { title: 'Cross-firm note', body: `Written by firm A, run ${RUN}.` };
    const B = firms.B;
    const refused = await addNote(
      seamRequest(`/v1/leads/${B.code}/notes`, asFirmA(B, 'source-intelligence'), B.code, 'source-intelligence', {
        method: 'POST',
        body: note,
      }),
      ctx(B.code),
    );
    await expectTenantRefusal(refused, B.code);
    expect(await readIntel(B.code)).toEqual(seededB.intel);

    const A = firms.A;
    const before = await readIntel(A.code);
    const allowed = await addNote(
      seamRequest(`/v1/leads/${A.code}/notes`, asFirmA(A, 'source-intelligence'), A.code, 'source-intelligence', {
        method: 'POST',
        body: note,
      }),
      ctx(A.code),
    );
    expect(allowed.status).toBe(200);
    const { noteId } = (await allowed.json()) as { noteId: string };
    const after = await readIntel(A.code);
    const notes = after?.notes as { noteId: string }[];
    expect(notes).toHaveLength((before?.notes as unknown[]).length + 1);
    expect(notes.map((row) => row.noteId)).toContain(noteId);
  });

  it('PATCH /v1/leads/[leadId]/fields: refused for B and the B lead_intel is unchanged; 200 for A', async () => {
    const B = firms.B;
    const refused = await patchFields(
      seamRequest(`/v1/leads/${B.code}/fields`, asFirmA(B, 'source-intelligence'), B.code, 'source-intelligence', {
        method: 'PATCH',
        body: { ifVersion: 1, patch: { winProbability: 0.99 } },
      }),
      ctx(B.code),
    );
    await expectTenantRefusal(refused, B.code);
    expect(await readIntel(B.code)).toEqual(seededB.intel);

    const A = firms.A;
    const before = await readIntel(A.code);
    const ifVersion = Number(before?.version);
    const allowed = await patchFields(
      seamRequest(`/v1/leads/${A.code}/fields`, asFirmA(A, 'source-intelligence'), A.code, 'source-intelligence', {
        method: 'PATCH',
        body: { ifVersion, patch: { winProbability: 0.42 } },
      }),
      ctx(A.code),
    );
    expect(allowed.status).toBe(200);
    const after = await readIntel(A.code);
    expect(after?.version).toBe(ifVersion + 1);
    expect((after?.fields as { winProbability: number }).winProbability).toBe(0.42);
  });

  it('POST /v1/leads/[leadId]/documents: refused for B and the B lead_documents are unchanged; 200 for A', async () => {
    const filing = {
      title: `Cross-firm brief ${RUN}`,
      documentType: 'md_brief',
      folder: 'md-brief',
      text: `Filed by firm A, run ${RUN}.`,
    };
    const B = firms.B;
    const refused = await fileDocument(
      seamRequest(`/v1/leads/${B.code}/documents`, asFirmA(B, 'md-briefing'), B.code, 'md-briefing', {
        method: 'POST',
        body: filing,
      }),
      ctx(B.code),
    );
    await expectTenantRefusal(refused, B.code);
    expect(await readDocuments(B.code)).toEqual(seededB.documents);

    const A = firms.A;
    const allowed = await fileDocument(
      seamRequest(`/v1/leads/${A.code}/documents`, asFirmA(A, 'md-briefing'), A.code, 'md-briefing', {
        method: 'POST',
        body: filing,
      }),
      ctx(A.code),
    );
    expect(allowed.status).toBe(200);
    const { documentId } = (await allowed.json()) as { documentId: string };
    A.documentIds.push(documentId);
    const stored = await readDocuments(A.code);
    expect(stored.map((row) => row.id)).toContain(documentId);
  });
});

/*
 * The cases above mint a token no mint site produces (A's tenant naming B's
 * code) so the request is guaranteed to reach the tenant wall. These present
 * the tokens a firm A run really holds on firm B's deal, and pin which wall
 * stops each one.
 */
describe("deal path: the tokens a real firm A run holds are refused on firm B's deal", () => {
  it("a deal run's token (A's own code) is refused on B's deal at the dealId binding", async () => {
    const B = firms.B;
    const read = await getLead(
      seamRequest(`/v1/leads/${B.code}`, realDealToken(firms.A, 'md-briefing'), B.code, 'md-briefing'),
      ctx(B.code),
    );
    await expectBindingRefusal(read, B.code);

    const write = await addNote(
      seamRequest(
        `/v1/leads/${B.code}/notes`,
        realDealToken(firms.A, 'source-intelligence'),
        B.code,
        'source-intelligence',
        { method: 'POST', body: { title: 'Cross-firm note', body: `Deal token, run ${RUN}.` } },
      ),
      ctx(B.code),
    );
    await expectBindingRefusal(write, B.code);
    expect(await readIntel(B.code)).toEqual(seededB.intel);
  });

  it("a deal run's token cannot tell B's deal code from one nobody holds", async () => {
    // The binding refuses both: an unused code resolves to nothing and B's
    // code to another deal. Both must be the same missing-lead answer.
    const unused = `PL02D-${RUN.toUpperCase()}`;
    const token = realDealToken(firms.A, 'md-briefing');
    await expectBindingRefusal(
      await getLead(seamRequest(`/v1/leads/${unused}`, token, unused, 'md-briefing'), ctx(unused)),
      unused,
    );

    const B = firms.B;
    await expectBindingRefusal(
      await getLead(seamRequest(`/v1/leads/${B.code}`, token, B.code, 'md-briefing'), ctx(B.code)),
      B.code,
    );
  });

  it("a company run's token (A's company id) reads nothing on B's deal: the binding stops it", async () => {
    const B = firms.B;
    const token = realCompanyToken(firms.A, 'presearch');
    await expectBindingRefusal(
      await getLead(seamRequest(`/v1/leads/${B.code}`, token, B.code, 'presearch'), ctx(B.code)),
      B.code,
    );
    await expectBindingRefusal(
      await listDocuments(
        seamRequest(`/v1/leads/${B.code}/documents`, token, B.code, 'presearch'),
        ctx(B.code),
      ),
      B.code,
    );
  });

  it("debrief's write-capable company token is refused on B's deal and B's lead_intel is unchanged", async () => {
    const B = firms.B;
    const token = realCompanyToken(firms.A, 'source-intelligence');
    await expectBindingRefusal(
      await addNote(
        seamRequest(`/v1/leads/${B.code}/notes`, token, B.code, 'source-intelligence', {
          method: 'POST',
          body: { title: 'Cross-firm note', body: `Company token, run ${RUN}.` },
        }),
        ctx(B.code),
      ),
      B.code,
    );
    await expectBindingRefusal(
      await patchFields(
        seamRequest(`/v1/leads/${B.code}/fields`, token, B.code, 'source-intelligence', {
          method: 'PATCH',
          body: { ifVersion: 1, patch: { winProbability: 0.99 } },
        }),
        ctx(B.code),
      ),
      B.code,
    );
    expect(await readIntel(B.code)).toEqual(seededB.intel);
  });

  it("a company run's token cannot tell B's deal code from one nobody holds", async () => {
    // The literal the tenant refusals are compared against is the real
    // missing-lead answer, not an assumption about it.
    const unused = `PL02N-${RUN.toUpperCase()}`;
    const token = realCompanyToken(firms.A, 'presearch');
    const missing = await getLead(seamRequest(`/v1/leads/${unused}`, token, unused, 'presearch'), ctx(unused));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual(missingLeadBody(unused));
    expect(takeDenyReason()).toBe('binding');

    const B = firms.B;
    await expectBindingRefusal(
      await getLead(seamRequest(`/v1/leads/${B.code}`, token, B.code, 'presearch'), ctx(B.code)),
      B.code,
    );
  });

  it("a company run's token (A's company id) reads nothing on B's company lead", async () => {
    // The original gap: a company token passed on another company-shaped lead.
    const B = firms.B;
    const token = realCompanyToken(firms.A, 'presearch');
    await expectBindingRefusal(
      await getLead(seamRequest(`/v1/leads/${B.targetId}`, token, B.targetId, 'presearch'), ctx(B.targetId)),
      B.targetId,
    );
  });

  it('leaves every firm B row exactly as seeded', async () => {
    expect(await readIntel(firms.B.code)).toEqual(seededB.intel);
    expect(await readDocuments(firms.B.code)).toEqual(seededB.documents);
  });
});

/*
 * The company path: lead id = companies.id, for a company with no deal.
 * loadConductiaLead falls through to loadConductiaLeadFromCompany, whose
 * ownerTenantId comes from companies.tenant_id rather than deals.tenant_id,
 * so this proves the tenant wall a second time over the other branch of that
 * function. As in the first deal-path describe, the token names the target's
 * OWN company-lead id as its claim, so claimBindsToLead passes trivially
 * (claim === path) and only the tenant wall can refuse.
 */
describe("company path: firm A's signed token on firm B's company-only lead is refused at the tenant wall", () => {
  it('GET /v1/leads/[leadId]: refused for B, 200 for A', async () => {
    const B = firms.B;
    const refused = await getLead(
      seamRequest(`/v1/leads/${B.companyLeadId}`, asFirmACompany(B, 'md-briefing'), B.companyLeadId, 'md-briefing'),
      ctx(B.companyLeadId),
    );
    await expectTenantRefusal(refused, B.companyLeadId);

    const A = firms.A;
    const allowed = await getLead(
      seamRequest(`/v1/leads/${A.companyLeadId}`, asFirmACompany(A, 'md-briefing'), A.companyLeadId, 'md-briefing'),
      ctx(A.companyLeadId),
    );
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as {
      lead: { leadId: string; version: number; record: { clientGoals: { whySelling: string } } };
    };
    expect(body.lead.leadId).toBe(A.companyLeadId);
    expect(body.lead.record.clientGoals.whySelling).toBe(`Firm A company seed ${RUN}`);
  });

  it('GET /v1/leads/[leadId]/documents: refused for B, 200 for A with only the A documents', async () => {
    const B = firms.B;
    const refused = await listDocuments(
      seamRequest(
        `/v1/leads/${B.companyLeadId}/documents`,
        asFirmACompany(B, 'md-briefing'),
        B.companyLeadId,
        'md-briefing',
      ),
      ctx(B.companyLeadId),
    );
    await expectTenantRefusal(refused, B.companyLeadId);

    const A = firms.A;
    const allowed = await listDocuments(
      seamRequest(
        `/v1/leads/${A.companyLeadId}/documents`,
        asFirmACompany(A, 'md-briefing'),
        A.companyLeadId,
        'md-briefing',
      ),
      ctx(A.companyLeadId),
    );
    expect(allowed.status).toBe(200);
    const { documents } = (await allowed.json()) as { documents: { documentId: string }[] };
    const ids = documents.map((doc) => doc.documentId);
    expect(ids).toContain(A.companyDocumentIds[0]);
    expect(ids).not.toContain(B.companyDocumentIds[0]);
  });

  it('POST /v1/leads/[leadId]/notes: refused for B and the B lead_intel is unchanged; 200 for A', async () => {
    const note = { title: 'Cross-firm company note', body: `Written by firm A, run ${RUN}.` };
    const B = firms.B;
    const refused = await addNote(
      seamRequest(
        `/v1/leads/${B.companyLeadId}/notes`,
        asFirmACompany(B, 'source-intelligence'),
        B.companyLeadId,
        'source-intelligence',
        { method: 'POST', body: note },
      ),
      ctx(B.companyLeadId),
    );
    await expectTenantRefusal(refused, B.companyLeadId);
    expect(await readIntel(B.companyLeadId)).toEqual(seededB.companyIntel);

    const A = firms.A;
    const before = await readIntel(A.companyLeadId);
    const allowed = await addNote(
      seamRequest(
        `/v1/leads/${A.companyLeadId}/notes`,
        asFirmACompany(A, 'source-intelligence'),
        A.companyLeadId,
        'source-intelligence',
        { method: 'POST', body: note },
      ),
      ctx(A.companyLeadId),
    );
    expect(allowed.status).toBe(200);
    const { noteId } = (await allowed.json()) as { noteId: string };
    const after = await readIntel(A.companyLeadId);
    const notes = after?.notes as { noteId: string }[];
    expect(notes).toHaveLength((before?.notes as unknown[]).length + 1);
    expect(notes.map((row) => row.noteId)).toContain(noteId);
  });

  it('PATCH /v1/leads/[leadId]/fields: refused for B and the B lead_intel is unchanged; 200 for A', async () => {
    const B = firms.B;
    const refused = await patchFields(
      seamRequest(
        `/v1/leads/${B.companyLeadId}/fields`,
        asFirmACompany(B, 'source-intelligence'),
        B.companyLeadId,
        'source-intelligence',
        { method: 'PATCH', body: { ifVersion: 1, patch: { winProbability: 0.99 } } },
      ),
      ctx(B.companyLeadId),
    );
    await expectTenantRefusal(refused, B.companyLeadId);
    expect(await readIntel(B.companyLeadId)).toEqual(seededB.companyIntel);

    const A = firms.A;
    const before = await readIntel(A.companyLeadId);
    const ifVersion = Number(before?.version);
    const allowed = await patchFields(
      seamRequest(
        `/v1/leads/${A.companyLeadId}/fields`,
        asFirmACompany(A, 'source-intelligence'),
        A.companyLeadId,
        'source-intelligence',
        { method: 'PATCH', body: { ifVersion, patch: { winProbability: 0.42 } } },
      ),
      ctx(A.companyLeadId),
    );
    expect(allowed.status).toBe(200);
    const after = await readIntel(A.companyLeadId);
    expect(after?.version).toBe(ifVersion + 1);
    expect((after?.fields as { winProbability: number }).winProbability).toBe(0.42);
  });

  it('POST /v1/leads/[leadId]/documents: refused for B and the B lead_documents are unchanged; 200 for A', async () => {
    const filing = {
      title: `Cross-firm company brief ${RUN}`,
      documentType: 'md_brief',
      folder: 'md-brief',
      text: `Filed by firm A, run ${RUN}.`,
    };
    const B = firms.B;
    const refused = await fileDocument(
      seamRequest(
        `/v1/leads/${B.companyLeadId}/documents`,
        asFirmACompany(B, 'md-briefing'),
        B.companyLeadId,
        'md-briefing',
        { method: 'POST', body: filing },
      ),
      ctx(B.companyLeadId),
    );
    await expectTenantRefusal(refused, B.companyLeadId);
    expect(await readDocuments(B.companyLeadId)).toEqual(seededB.companyDocuments);

    const A = firms.A;
    const allowed = await fileDocument(
      seamRequest(
        `/v1/leads/${A.companyLeadId}/documents`,
        asFirmACompany(A, 'md-briefing'),
        A.companyLeadId,
        'md-briefing',
        { method: 'POST', body: filing },
      ),
      ctx(A.companyLeadId),
    );
    expect(allowed.status).toBe(200);
    const { documentId } = (await allowed.json()) as { documentId: string };
    A.companyDocumentIds.push(documentId);
    const stored = await readDocuments(A.companyLeadId);
    expect(stored.map((row) => row.id)).toContain(documentId);
  });
});

/*
 * The shared instance key authenticates the seam but names no firm, so on a
 * lead route it would reach every firm's data. It is refused before the lead
 * is even looked up, on both paths, for reads and writes alike. There is no
 * 200 control: no lead route accepts it any more.
 */
describe('the shared instance key is refused on every lead route', () => {
  const key = () => `pl02-key-${RUN}`;

  it("deal path: GET and POST notes on B's deal are refused 401 and B's lead_intel is unchanged", async () => {
    const B = firms.B;
    await expectApiKeyRefusal(
      await getLead(seamRequest(`/v1/leads/${B.code}`, key(), B.code, 'md-briefing'), ctx(B.code)),
    );
    await expectApiKeyRefusal(
      await addNote(
        seamRequest(`/v1/leads/${B.code}/notes`, key(), B.code, 'source-intelligence', {
          method: 'POST',
          body: { title: 'Key note', body: `Shared key, run ${RUN}.` },
        }),
        ctx(B.code),
      ),
    );
    expect(await readIntel(B.code)).toEqual(seededB.intel);
  });

  it("company path: GET documents and PATCH fields on B's company lead are refused 401 and B's rows are unchanged", async () => {
    const B = firms.B;
    await expectApiKeyRefusal(
      await listDocuments(
        seamRequest(`/v1/leads/${B.companyLeadId}/documents`, key(), B.companyLeadId, 'md-briefing'),
        ctx(B.companyLeadId),
      ),
    );
    await expectApiKeyRefusal(
      await patchFields(
        seamRequest(`/v1/leads/${B.companyLeadId}/fields`, key(), B.companyLeadId, 'source-intelligence', {
          method: 'PATCH',
          body: { ifVersion: 1, patch: { winProbability: 0.99 } },
        }),
        ctx(B.companyLeadId),
      ),
    );
    expect(await readIntel(B.companyLeadId)).toEqual(seededB.companyIntel);
    expect(await readDocuments(B.companyLeadId)).toEqual(seededB.companyDocuments);
  });
});

/*
 * There is no lead in a persona path. The verified conductiaTenantId claim
 * walls firms apart in the store filters (`listPersonas` / `getPersona` /
 * `updatePersona`), and the token's dealId claim is bound to the persona's
 * links: a run reads and writes only personas linked to its own lead.
 */
describe('personas: firm A never reads or writes firm B\'s personas, nor its own off-lead ones', () => {
  it("A's token does not see A's own personas that are unlinked or linked to another lead", async () => {
    const offLeadIds = [`per_pl02_A_unlinked_${RUN}`, `per_pl02_A_offlead_${RUN}`];
    const seed = (id: string, links: unknown[]) => ({
      id,
      tenant_id: HANDLE,
      conductia_tenant_id: firms.A.tenantId,
      name: `Firm A off-lead ${RUN}`,
      title: 'Operating Partner',
      organization: `PL02 Seam Target A ${RUN}`,
      type: 'contact',
      tags: [],
      body: 'Off-lead persona.',
      version: 1,
      authored_by: 'agent',
      links,
      evidence: [],
      history: [],
    });
    const { error } = await db.from('lead_personas').insert([
      seed(offLeadIds[0], []),
      seed(offLeadIds[1], [{ tenantId: HANDLE, leadId: firms.B.code, contactId: `contact_pl02_off_${RUN}` }]),
    ]);
    if (error) throw new Error(`lead_personas seed failed: ${error.message}`);

    const token = personaToken(firms.A);
    const res = await listPersonas(seamRequest('/v1/personas', token, firms.A.targetId, 'digital-twin'));
    expect(res.status).toBe(200);
    const { personas } = (await res.json()) as { personas: { personaId: string }[] };
    const ids = personas.map((persona) => persona.personaId);
    expect(ids).toContain(firms.A.personaId);
    for (const id of offLeadIds) {
      expect(ids).not.toContain(id);
      const read = await getPersonaRoute(
        seamRequest(`/v1/personas/${id}`, token, firms.A.targetId, 'digital-twin'),
        personaCtx(id),
      );
      expect(read.status).toBe(404);
      const edit = await patchPersonaRoute(
        seamRequest(`/v1/personas/${id}`, token, firms.A.targetId, 'digital-twin', {
          method: 'PATCH',
          body: { ifVersion: 1, patch: { name: 'Edited off lead' } },
        }),
        personaCtx(id),
      );
      expect(edit.status).toBe(404);
    }
  });

  it("GET /v1/personas: A sees its own persona, never B's", async () => {
    const token = personaToken(firms.A);
    const res = await listPersonas(
      seamRequest('/v1/personas', token, firms.A.targetId, 'digital-twin'),
    );
    expect(res.status).toBe(200);
    const { personas } = (await res.json()) as { personas: { personaId: string }[] };
    const ids = personas.map((persona) => persona.personaId);
    expect(ids).toContain(firms.A.personaId);
    expect(ids).not.toContain(firms.B.personaId);
  });

  it("GET /v1/personas/[personaId]: A's token on B's persona is refused, 404", async () => {
    const token = personaToken(firms.A);
    const res = await getPersonaRoute(
      seamRequest(`/v1/personas/${firms.B.personaId}`, token, firms.A.targetId, 'digital-twin'),
      personaCtx(firms.B.personaId),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; detail: unknown } };
    expect(body.error.code).toBe('not_found');
    expect(body.error.detail).toEqual({ personaId: firms.B.personaId });
  });

  it("PATCH /v1/personas/[personaId]: A's token on B's persona is refused, 404, and B's row is unchanged; 200 for A's own", async () => {
    const token = personaToken(firms.A);
    const refused = await patchPersonaRoute(
      seamRequest(`/v1/personas/${firms.B.personaId}`, token, firms.A.targetId, 'digital-twin', {
        method: 'PATCH',
        body: { ifVersion: 1, patch: { name: 'Hijacked by firm A' } },
      }),
      personaCtx(firms.B.personaId),
    );
    expect(refused.status).toBe(404);
    const body = (await refused.json()) as { error: { code: string; detail: unknown } };
    expect(body.error.code).toBe('not_found');
    expect(body.error.detail).toEqual({ personaId: firms.B.personaId });
    expect(await readPersona(firms.B.personaId)).toEqual(seededB.persona);

    const allowed = await patchPersonaRoute(
      seamRequest(`/v1/personas/${firms.A.personaId}`, token, firms.A.targetId, 'digital-twin', {
        method: 'PATCH',
        body: { ifVersion: 1, patch: { name: 'Firm A Persona, updated' } },
      }),
      personaCtx(firms.A.personaId),
    );
    expect(allowed.status).toBe(200);
    const after = await readPersona(firms.A.personaId);
    expect(after?.name).toBe('Firm A Persona, updated');
    expect(after?.version).toBe(2);
  });

  it("POST /v1/personas/[personaId]/links: A's persona linked to B's lead is refused and A's links are unchanged", async () => {
    const token = personaToken(firms.A);
    const before = await readPersona(firms.A.personaId);
    const refused = await linkPersonaRoute(
      seamRequest(`/v1/personas/${firms.A.personaId}/links`, token, firms.A.targetId, 'digital-twin', {
        method: 'POST',
        body: { link: { leadId: firms.B.code, contactId: `contact_pl02_${RUN}` } },
      }),
      personaCtx(firms.A.personaId),
    );
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as { error: { code: string; detail: unknown } };
    expect(body.error.code).toBe('scope_denied');
    expect(body.error.detail).toEqual({ field: 'link.leadId' });
    expect(await readPersona(firms.A.personaId)).toEqual(before);

    const allowed = await linkPersonaRoute(
      seamRequest(`/v1/personas/${firms.A.personaId}/links`, token, firms.A.targetId, 'digital-twin', {
        method: 'POST',
        body: { link: { leadId: firms.A.code, contactId: `contact_pl02_${RUN}` } },
      }),
      personaCtx(firms.A.personaId),
    );
    expect(allowed.status).toBe(200);
    const after = await readPersona(firms.A.personaId);
    const links = after?.links as { leadId: string; contactId: string }[];
    expect(links.map((link) => link.leadId)).toContain(firms.A.code);
  });

  it("POST /v1/personas/[personaId]/links: a deal firm B owns is refused even when its target is firm A's company", async () => {
    // The owner is deals.tenant_id (B). The target company's tenant (A) would
    // have let this link through, filing A's persona under B's deal.
    const token = personaToken(firms.A);
    const before = await readPersona(firms.A.personaId);
    const refused = await linkPersonaRoute(
      seamRequest(`/v1/personas/${firms.A.personaId}/links`, token, firms.A.targetId, 'digital-twin', {
        method: 'POST',
        body: { link: { leadId: split.code, contactId: `contact_pl02_split_${RUN}` } },
      }),
      personaCtx(firms.A.personaId),
    );
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as { error: { code: string; detail: unknown } };
    expect(body.error.code).toBe('scope_denied');
    expect(body.error.detail).toEqual({ field: 'link.leadId' });
    expect(await readPersona(firms.A.personaId)).toEqual(before);
  });

  it('leaves every new firm B row (company path, persona) exactly as seeded', async () => {
    expect(await readIntel(firms.B.companyLeadId)).toEqual(seededB.companyIntel);
    expect(await readDocuments(firms.B.companyLeadId)).toEqual(seededB.companyDocuments);
    expect(await readPersona(firms.B.personaId)).toEqual(seededB.persona);
  });
});
