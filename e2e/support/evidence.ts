import { expect, type APIRequestContext } from '@playwright/test';

export type AuditEvent = {
  id: string;
  ts: string;
  action: string;
  document_id: string | null;
  detail: unknown;
  actor: { id: string; full_name: string | null; display_name: string | null } | null;
};

export type DealRow = {
  id: string;
  code: string;
  codename: string;
  status: string;
  entry_step_seq: number | null;
  current_step_seq: number | null;
  targetCloseDate: string | null;
  feeUsd: number | null;
  scheduleStatus: string | null;
  lifecycleCategory: string;
};

export type TeamMember = {
  userId: string;
  email: string | null;
  dealRole: string;
  companyId: string | null;
};

export type DealMember = {
  deal_role: string;
  user: { id: string; email: string } | null;
};

export type DocumentRow = {
  id: string;
  name: string;
  room: string;
  classification: number;
  sizeBytes: number | null;
  folder: string;
  hasFile: boolean;
  canOpen: boolean;
};

export type OutboxMessage = {
  id: string;
  status: string;
  verdict: string;
  provider: string | null;
  llmChecked: boolean;
  subject: string;
  to: string[];
};

export type StepRow = { stepId: string; seq: number; label: string; railStatus: string };

export type LeadRelationshipRow = {
  id: string;
  person_name: string;
  relationship_type: string;
  strength: string;
};

export type LeadStakeholderRow = {
  id: string;
  name: string;
  role_in_decision: string;
  stance: string;
};

export type PersonRow = { id: string; name: string; email: string | null };
export type CompanyMemberRow = {
  id: string;
  email: string;
  full_name: string;
  display_name: string | null;
  company_role: string | null;
};

export type CompanyEffectivePermissionRow = {
  permissionKey: string;
  source: { type: string; id: string | null; name: string | null };
};

export type CompanyAccessSnapshot = {
  version: number;
  assigned_roles: Array<{ id: string; name: string }>;
  direct_permissions: string[];
  effective_permissions: CompanyEffectivePermissionRow[];
};

export type AccessRequestSummary = {
  id: string;
  requesterId: string;
  requesterName: string | null;
  destination: string;
  destinationLabel: string;
  permissionKey: string;
  status: string;
};

export type StepDetail = {
  step: {
    stepId: string;
    seq: number;
    status: string;
    assignedTo: string | null;
    assignedToName: string | null;
    completedBy: string | null;
    completedAt: string | null;
    completionNote: string | null;
    work: Record<string, unknown>;
  };
  members: Array<{ id: string; name: string; dealRole: string }>;
  permissions: { isMd: boolean; canAssign: boolean; canComplete: boolean; canEditWork: boolean };
};

export type MeResponse = {
  user: {
    id: string;
    email: string;
    full_name: string;
    display_name: string | null;
    firm_role: string | null;
    company_role: string | null;
    company_id: string | null;
    department: string | null;
  };
  company: { id: string; name: string } | null;
  company_permissions?: CompanyEffectivePermissionRow[];
  mandate: {
    dealId: string;
    code: string;
    codename: string;
    status: string;
    dealRole: string;
    targetName: string | null;
  } | null;
  memberships: Array<{ deal_id: string; deal_role: string; deal_code: string | null }>;
};

async function json<T>(request: APIRequestContext, url: string): Promise<T> {
  const response = await request.get(url);
  expect(response.status(), `GET ${url}`).toBe(200);
  return (await response.json()) as T;
}

/**
 * Reads back as the MD, not with the service key. The service key would prove a
 * row exists; the MD's own session proves the row exists AND is visible to the
 * identity that created it (design: evidence layer).
 */
export class Evidence {
  constructor(public readonly request: APIRequestContext) {}

  me() {
    return json<MeResponse>(this.request, '/api/v1/me');
  }

  listCompanyMembers(companyId: string) {
    return json<{ members: CompanyMemberRow[] }>(
      this.request,
      `/api/v1/companies/${encodeURIComponent(companyId)}/members`,
    );
  }

  getMemberAccess(companyId: string, userId: string) {
    return json<{ access: CompanyAccessSnapshot }>(
      this.request,
      `/api/v1/companies/${encodeURIComponent(companyId)}/members/${encodeURIComponent(userId)}/access`,
    );
  }

  async replaceMemberAccess(
    companyId: string,
    userId: string,
    body: { expectedVersion: number; roleIds: string[]; directPermissions: string[] },
  ): Promise<CompanyAccessSnapshot> {
    const url = `/api/v1/companies/${encodeURIComponent(companyId)}/members/${encodeURIComponent(userId)}/access`;
    const response = await this.request.patch(url, { data: body });
    expect(response.status(), `PATCH ${url}`).toBe(200);
    const payload = (await response.json()) as { access: CompanyAccessSnapshot };
    return payload.access;
  }

  listAccessRequests() {
    return json<{ mine: AccessRequestSummary[]; inbox: AccessRequestSummary[] }>(
      this.request,
      '/api/v1/access-requests',
    );
  }

  listRelationships(companyId: string) {
    return json<{ relationships: LeadRelationshipRow[] }>(
      this.request,
      `/api/v1/companies/${encodeURIComponent(companyId)}/relationships`,
    );
  }

  listStakeholders(companyId: string) {
    return json<{ stakeholders: LeadStakeholderRow[] }>(
      this.request,
      `/api/v1/companies/${encodeURIComponent(companyId)}/stakeholders`,
    );
  }

  /** Person search is a POST: the typed text never rides in a URL (#331). */
  async listCompanyEmployees() {
    const url = '/api/v1/people/search';
    const response = await this.request.post(url, { data: { scope: 'company_employees' } });
    expect(response.status(), `POST ${url}`).toBe(200);
    return (await response.json()) as { people: PersonRow[] };
  }

  getDeal(ref: string) {
    return json<{ deal: DealRow; members: DealMember[] }>(
      this.request,
      `/api/v1/deals/${encodeURIComponent(ref)}`,
    );
  }

  /** The live Team roster, and the id of the deal's own advisory bank. */
  listTeam(ref: string) {
    return json<{ members: TeamMember[]; bankCompanyId: string | null }>(
      this.request,
      `/api/v1/deals/${encodeURIComponent(ref)}/members`,
    );
  }

  listSteps(ref: string) {
    return json<{ steps: StepRow[] }>(
      this.request,
      `/api/v1/deals/${encodeURIComponent(ref)}/steps`,
    );
  }

  getStep(ref: string, stepId: string) {
    return json<StepDetail>(
      this.request,
      `/api/v1/deals/${encodeURIComponent(ref)}/steps/${encodeURIComponent(stepId)}`,
    );
  }

  listDocuments(ref: string) {
    return json<{ documents: DocumentRow[] }>(
      this.request,
      `/api/v1/deals/${encodeURIComponent(ref)}/documents`,
    );
  }

  /**
   * `dealId` mirrors the route's own lenient `dealId` query param
   * (`resolveDealRefLenient` in `src/app/api/v1/outbox/route.ts`): pass a
   * deal ref/code to scope the read. Without it the route returns only the
   * caller's most recent 50 messages tenant-wide (or all held/sent on the
   * tenant for an overseer) — harmless on the hermetic tier's fresh
   * database, but on the live tier's persistent one an older message can
   * fall off the page. Callers proving a specific send should always pass
   * the deal ref.
   */
  listOutbox(dealId?: string) {
    const qs = dealId ? `?dealId=${encodeURIComponent(dealId)}` : '';
    return json<{ messages: OutboxMessage[] }>(this.request, `/api/v1/outbox${qs}`);
  }

  listAudit(ref: string) {
    return json<{ deal: { id: string; code: string; codename: string }; events: AuditEvent[] }>(
      this.request,
      `/api/v1/deals/${encodeURIComponent(ref)}/audit`,
    );
  }

  /** The caller's own display name, as the deal's audit trail records it. */
  async myDisplayName(ref: string): Promise<string> {
    const me = await this.me();
    const { events } = await this.listAudit(ref);
    const mine = events.find((event) => event.actor?.id === me.user.id);
    const name = mine?.actor?.display_name || mine?.actor?.full_name;
    expect(name, `no audited action on ${ref} carries the caller's name`).toBeTruthy();
    return name as string;
  }

  /**
   * One shared audit assertion. `since` is the run's start timestamp, so a
   * shared database carrying other people's rows cannot produce a false
   * positive (design: evidence layer).
   */
  async expectAudit(
    ref: string,
    opts: { action: string; actorId?: string; since: string },
  ): Promise<AuditEvent> {
    const { events } = await this.listAudit(ref);
    const match = events.find(
      (event) =>
        event.action === opts.action &&
        event.ts >= opts.since &&
        (!opts.actorId || event.actor?.id === opts.actorId),
    );
    expect(
      match,
      `no '${opts.action}' audit entry on ${ref} after ${opts.since}; saw: ${events
        .map((e) => `${e.action}@${e.ts}`)
        .join(', ')}`,
    ).toBeTruthy();
    return match as AuditEvent;
  }

  /**
   * The rail's step actions all share one action name per verb, so a journey
   * touching several steps needs the step id from `detail` to tell them apart.
   */
  async expectStepAudit(
    ref: string,
    opts: { action: string; stepId: string; actorId?: string; since: string },
  ): Promise<AuditEvent> {
    const { events } = await this.listAudit(ref);
    const match = events.find(
      (event) =>
        event.action === opts.action &&
        event.ts >= opts.since &&
        (!opts.actorId || event.actor?.id === opts.actorId) &&
        (event.detail as { stepId?: string } | null)?.stepId === opts.stepId,
    );
    expect(
      match,
      `no '${opts.action}' audit entry for ${opts.stepId} on ${ref} after ${opts.since}; saw: ${events
        .map((e) => `${e.action}@${e.ts}`)
        .join(', ')}`,
    ).toBeTruthy();
    return match as AuditEvent;
  }
}
