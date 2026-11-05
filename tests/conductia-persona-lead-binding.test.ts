import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseAdminClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
}));
vi.mock('@/lib/dataroom/steps', () => ({ loadDealByIdOrCode: vi.fn() }));
vi.mock('@/lib/conductia/lead', () => ({ loadConductiaLead: vi.fn() }));
vi.mock('@/lib/conductia/personas', () => ({
  getPersona: vi.fn(),
  linkPersona: vi.fn(),
  createPersona: vi.fn(),
  updatePersona: vi.fn(),
  listPersonas: vi.fn(),
  personaRead: vi.fn(),
  personaSummary: vi.fn(),
  personaReceipt: (persona: { personaId: string }, action: string) => ({ personaId: persona.personaId, action }),
}));

import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { loadDealByIdOrCode } from '@/lib/dataroom/steps';
import { loadConductiaLead } from '@/lib/conductia/lead';
import {
  createPersona,
  getPersona,
  linkPersona,
  listPersonas,
  personaRead,
  personaSummary,
  updatePersona,
} from '@/lib/conductia/personas';
import { digitalTwinScopes, mintTriggerToken } from '@/lib/ignatious/jwt';
import { GET as listGet, POST as createPost } from '@/app/v1/personas/route';
import { GET as personaGet, PATCH as personaPatch } from '@/app/v1/personas/[personaId]/route';
import { POST as linkPost } from '@/app/v1/personas/[personaId]/links/route';

const LEAD = 'FALCO-2026-100';
const OTHER_LEAD = 'OTHER-2026-001';
const DEAL_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_DEAL_ID = '22222222-2222-4222-8222-222222222222';

function fakeAdmin() {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'order', 'limit']) builder[method] = () => builder;
  builder.maybeSingle = async () => ({ data: null, error: null });
  builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
  return { from: () => builder };
}

function personaRequest(method: string, body: unknown, dealId: string = LEAD): Request {
  const token = mintTriggerToken({
    conductiaTenantId: 'tenant-a',
    agentName: 'digital-twin',
    dealId,
    scopes: digitalTwinScopes(),
  });
  return new Request('http://localhost:3000/v1/personas', {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-conductia-tenant-id': 'tn_demo',
      'x-conductia-lead-id': LEAD,
      'x-conductia-agent-name': 'digital-twin',
      'x-conductia-run-id': 'run_1',
    },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ personaId: 'p-1' }) };
const stored = (leadIds: string[]) => ({
  personaId: 'p-1',
  version: 1,
  linkedContacts: leadIds.map((leadId) => ({ tenantId: 'tenant-a', leadId, contactId: 'c-1' })),
});

beforeEach(() => {
  vi.stubEnv('IGNATIOUS_CONTROL_PLANE_URL', 'http://localhost:4111');
  vi.stubEnv('IGNATIOUS_API_KEY', 'local-dev-key');
  vi.stubEnv('IGNATIOUS_TENANT_ID', 'tn_demo');
  vi.stubEnv('CONDUCTIA_TRIGGER_TOKEN_SECRET', 'test-signing-secret');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(createSupabaseAdminClient).mockReturnValue(
    fakeAdmin() as unknown as ReturnType<typeof createSupabaseAdminClient>,
  );
  vi.mocked(loadDealByIdOrCode).mockImplementation(async (_admin, idOrCode: string) =>
    idOrCode === LEAD
      ? { id: DEAL_ID, code: LEAD }
      : idOrCode === OTHER_LEAD
        ? { id: OTHER_DEAL_ID, code: OTHER_LEAD }
        : null,
  );
  // Both leads are the token's firm: only the lead binding can refuse.
  vi.mocked(loadConductiaLead).mockResolvedValue({ ownerTenantId: 'tenant-a' } as never);
  vi.mocked(getPersona).mockResolvedValue(stored([]) as never);
  vi.mocked(linkPersona).mockResolvedValue(stored([LEAD]) as never);
  vi.mocked(createPersona).mockResolvedValue(stored([LEAD]) as never);
  vi.mocked(updatePersona).mockResolvedValue(stored([LEAD]) as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('persona writes are held to the token lead', () => {
  it('links a contact on the token lead', async () => {
    const res = await linkPost(personaRequest('POST', { link: { leadId: LEAD, contactId: 'c-1' } }), params);
    expect(res.status).toBe(200);
  });

  it('refuses a link onto another lead of the same firm', async () => {
    const res = await linkPost(personaRequest('POST', { link: { leadId: OTHER_LEAD, contactId: 'c-1' } }), params);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'scope_denied', detail: { field: 'link.leadId' } } });
    expect(linkPersona).not.toHaveBeenCalled();
  });

  it('refuses creating a persona already linked to another lead', async () => {
    const res = await createPost(
      personaRequest('POST', { name: 'Ada', link: { tenantId: 'x', leadId: OTHER_LEAD, contactId: 'c-1' } }),
    );
    expect(res.status).toBe(403);
    expect(createPersona).not.toHaveBeenCalled();
  });

  it('creates a persona linked to the token lead, and refuses one with no link', async () => {
    const created = await createPost(personaRequest('POST', { name: 'Ada', link: { leadId: LEAD, contactId: 'c-1' } }));
    expect(created.status).toBe(201);

    vi.mocked(createPersona).mockClear();
    for (const body of [{ name: 'Ada' }, { name: 'Ada', link: { leadId: LEAD } }]) {
      const res = await createPost(personaRequest('POST', body));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'validation', detail: { field: 'link' } } });
    }
    expect(createPersona).not.toHaveBeenCalled();
  });

  it('updates a persona linked to the token lead', async () => {
    vi.mocked(getPersona).mockResolvedValue(stored([LEAD]) as never);
    expect((await personaPatch(personaRequest('PATCH', { ifVersion: 1, patch: {} }), params)).status).toBe(200);
  });

  it('answers 404 to an update of an unlinked persona, and 200 once the run links it', async () => {
    vi.mocked(getPersona).mockResolvedValue(stored([]) as never);
    const patch = () => personaPatch(personaRequest('PATCH', { ifVersion: 1, patch: {} }), params);
    const refused = await patch();
    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({ error: { code: 'not_found', detail: { personaId: 'p-1' } } });
    expect(updatePersona).not.toHaveBeenCalled();

    // The first link on an unlinked persona is allowed: create-then-link.
    const link = await linkPost(personaRequest('POST', { link: { leadId: LEAD, contactId: 'c-1' } }), params);
    expect(link.status).toBe(200);
    expect(linkPersona).toHaveBeenCalled();

    vi.mocked(getPersona).mockResolvedValue(stored([LEAD]) as never);
    expect((await patch()).status).toBe(200);
    expect(updatePersona).toHaveBeenCalled();
  });

  it('answers 404 to an update of a persona on another lead', async () => {
    vi.mocked(getPersona).mockResolvedValue(stored([OTHER_LEAD]) as never);
    const res = await personaPatch(personaRequest('PATCH', { ifVersion: 1, patch: {} }), params);
    expect(res.status).toBe(404);
    expect(updatePersona).not.toHaveBeenCalled();
  });

  it('cannot unlock another lead persona by linking its own lead onto it first', async () => {
    vi.mocked(getPersona).mockResolvedValue(stored([OTHER_LEAD]) as never);
    const patch = () => personaPatch(personaRequest('PATCH', { ifVersion: 1, patch: {} }), params);

    expect((await patch()).status).toBe(404);
    const link = await linkPost(personaRequest('POST', { link: { leadId: LEAD, contactId: 'c-1' } }), params);
    expect(link.status).toBe(404);
    expect(await link.json()).toMatchObject({ error: { code: 'not_found', detail: { personaId: 'p-1' } } });
    expect(linkPersona).not.toHaveBeenCalled();
    expect((await patch()).status).toBe(404);
    expect(updatePersona).not.toHaveBeenCalled();
  });

  it('writes the update only on the version it authorized', async () => {
    // The caller read version 1; a link since then moved it to version 2.
    vi.mocked(getPersona).mockResolvedValue({ ...stored([LEAD]), version: 2 } as never);
    const res = await personaPatch(personaRequest('PATCH', { ifVersion: 1, patch: {} }), params);
    expect(res.status).toBe(409);
    expect(updatePersona).not.toHaveBeenCalled();

    vi.mocked(getPersona).mockResolvedValue(stored([LEAD]) as never);
    await personaPatch(personaRequest('PATCH', { ifVersion: 1, patch: {} }), params);
    expect(vi.mocked(updatePersona).mock.calls[0][4]).toBe(1);
  });

  it('links on the version it authorized, and answers 409 when that write misses', async () => {
    vi.mocked(getPersona).mockResolvedValue({ ...stored([]), version: 3 } as never);
    await linkPost(personaRequest('POST', { link: { leadId: LEAD, contactId: 'c-1' } }), params);
    expect(vi.mocked(linkPersona).mock.calls[0][4]).toBe(3);

    vi.mocked(linkPersona).mockRejectedValue(Object.assign(new Error('moved'), { name: 'VersionConflict' }));
    const res = await linkPost(personaRequest('POST', { link: { leadId: LEAD, contactId: 'c-1' } }), params);
    expect(res.status).toBe(409);
  });

  it('refuses a lead another firm owns with the same answer as an off-run lead of its own firm', async () => {
    const create = (leadId: string) =>
      createPost(personaRequest('POST', { name: 'Ada', link: { tenantId: 'x', leadId, contactId: 'c-1' } }));
    const sameFirm = await create(OTHER_LEAD);
    vi.mocked(loadConductiaLead).mockResolvedValue({ ownerTenantId: 'tenant-b' } as never);
    const otherFirm = await create(LEAD);
    expect(otherFirm.status).toBe(403);
    expect(sameFirm.status).toBe(403);
    expect(await otherFirm.json()).toEqual(await sameFirm.json());
    expect(createPersona).not.toHaveBeenCalled();
  });

  it('answers 404 to a link on a persona that does not exist', async () => {
    vi.mocked(getPersona).mockResolvedValue(null as never);
    const res = await linkPost(personaRequest('POST', { link: { leadId: LEAD, contactId: 'c-1' } }), params);
    expect(res.status).toBe(404);
    expect(linkPersona).not.toHaveBeenCalled();
  });
});

describe('persona reads are held to the token lead', () => {
  const persona = (id: string, leadIds: string[]) => ({ ...stored(leadIds), personaId: id });

  beforeEach(() => {
    vi.mocked(personaSummary).mockImplementation(((p: { personaId: string }) => ({ personaId: p.personaId })) as never);
    vi.mocked(personaRead).mockImplementation(((p: { personaId: string }) => ({ personaId: p.personaId })) as never);
  });

  it('lists only personas linked to the token lead: off-lead and unlinked are left out', async () => {
    vi.mocked(listPersonas).mockResolvedValue([
      persona('on-lead', [LEAD]),
      persona('both', [OTHER_LEAD, LEAD]),
      persona('off-lead', [OTHER_LEAD]),
      persona('unlinked', []),
    ] as never);
    const res = await listGet(personaRequest('GET', undefined));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ personas: [{ personaId: 'on-lead' }, { personaId: 'both' }] });
  });

  it('refuses a token with no lead claim rather than listing nothing', async () => {
    vi.mocked(listPersonas).mockResolvedValue([persona('on-lead', [LEAD])] as never);
    const res = await listGet(personaRequest('GET', undefined, ''));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'scope_denied' } });
  });

  it('fails closed when the binding cannot be read', async () => {
    vi.mocked(listPersonas).mockResolvedValue([persona('off-lead', [OTHER_LEAD])] as never);
    vi.mocked(loadDealByIdOrCode).mockRejectedValue(new Error('db down'));
    const res = await listGet(personaRequest('GET', undefined));
    expect(res.status).toBe(503);
  });

  it('reads a persona linked to the token lead', async () => {
    vi.mocked(getPersona).mockResolvedValue(persona('p-1', [LEAD]) as never);
    const res = await personaGet(personaRequest('GET', undefined), params);
    expect(res.status).toBe(200);
  });

  it.each([
    ['another lead', [OTHER_LEAD]],
    ['no lead', []],
  ])('answers the missing 404 for a persona linked to %s', async (_label, leadIds) => {
    vi.mocked(getPersona).mockResolvedValue(persona('p-1', leadIds) as never);
    const res = await personaGet(personaRequest('GET', undefined), params);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found', detail: { personaId: 'p-1' } } });
    expect(personaRead).not.toHaveBeenCalled();
  });
});
