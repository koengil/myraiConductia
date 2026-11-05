import type { SupabaseClient } from '@supabase/supabase-js';

import { isUuid } from '@/lib/api/v1/http';
import { TABLE } from '@/lib/constants/tables';
import { safeLogId } from '@/lib/errors/logSafe';
import { loadDealByIdOrCode } from '@/lib/dataroom/steps';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

import { requireConductiaScope, type ConductiaScope } from './auth';
import { conductiaError } from './errors';
import { loadConductiaLead, type ConductiaLead } from './lead';
import { getPersona, type StoredPersona } from './personas';
import type { AgentScope } from './scopes';
import { dbFailure } from '@/lib/errors/upstream';

export async function requireConductiaAdmin(
  request: Request,
  required?: AgentScope,
): Promise<
  | { ok: true; scope: ConductiaScope; admin: SupabaseClient }
  | { ok: false; response: Response }
> {
  const gate = requireConductiaScope(request, undefined, required);
  if (!gate.ok) return gate;
  try {
    return { ok: true, scope: gate.scope, admin: createSupabaseAdminClient() };
  } catch {
    return {
      ok: false,
      response: conductiaError('server_error', 'Conductia storage is not configured.', 503),
    };
  }
}

/** What a lead id names, in the two keys a lead can be compared on. */
type LeadKey = { dealId: string | null; companyIds: string[] };

/**
 * Resolve a lead id (deal uuid, deal code or company uuid) to its keys. A deal
 * carries its own id and EVERY target company (deal_parties allows more than
 * one), the companies its company-scoped runs are minted for. Null when the id
 * names neither. A failed read throws.
 */
async function resolveLeadKey(admin: SupabaseClient, leadId: string): Promise<LeadKey | null> {
  const deal = await loadDealByIdOrCode(admin, leadId);
  if (deal) {
    const { data, error } = await admin
      .from(TABLE.DEAL_PARTIES)
      .select('company_id')
      .eq('deal_id', deal.id)
      .eq('party_role', 'target');
    if (error) throw dbFailure('Lead party lookup', error);
    const targets = ((data as { company_id: string | null }[] | null) ?? [])
      .map((row) => row.company_id)
      .filter((id): id is string => Boolean(id));
    return { dealId: deal.id, companyIds: targets };
  }
  // companies.id is a uuid; anything else is not a company lead.
  if (!isUuid(leadId)) return null;
  const { data, error } = await admin
    .from(TABLE.COMPANIES)
    .select('id')
    .eq('id', leadId)
    .maybeSingle();
  if (error) throw dbFailure('Lead company lookup', error);
  return data?.id ? { dealId: null, companyIds: [data.id as string] } : null;
}

/**
 * Hold a verified token to the lead it was minted for.
 *
 * The `dealId` claim is not uniform across agents: the lead-scoped ones mint
 * the lead id, skill bench mints the deal's uuid, and the company-scoped ones
 * (presearch, digital twin) mint a COMPANY id. So both sides resolve to their
 * keys and compare: the same deal when both name a deal, otherwise the same
 * company, a deal comparing as any of its targets. An id that resolves to nothing is
 * refused, never stood down on: a company token used to pass here on any lead
 * of the firm. A failed read throws, and the caller refuses the request.
 */
export async function claimBindsToLead(
  admin: SupabaseClient,
  claimedDealId: string,
  pathLeadId: string,
): Promise<boolean> {
  if (claimedDealId === pathLeadId) return true;
  const claimed = await resolveLeadKey(admin, claimedDealId);
  if (!claimed) return false;
  const target = await resolveLeadKey(admin, pathLeadId);
  if (!target) return false;
  if (claimed.dealId && target.dealId) return claimed.dealId === target.dealId;
  return claimed.companyIds.some((id) => target.companyIds.includes(id));
}

/**
 * The persona gate: requireConductiaAdmin, plus a non-null Conductia tenant.
 *
 * Personas are tenant-scoped, not lead-scoped, so there is no lead in the path
 * to resolve and prove ownership with -- the lead boundary that covers the rest
 * of this seam cannot reach them. The verified tenant claim is their ONLY
 * isolation control, so a credential carrying no claim cannot read or write
 * them. That includes the shared API key, which is a trusted operator path
 * everywhere else but here has nothing to scope by, so it fails closed.
 */
export async function requireConductiaPersonaScope(
  request: Request,
  required?: AgentScope,
): Promise<
  | { ok: true; scope: ConductiaScope; conductiaTenantId: string; admin: SupabaseClient }
  | { ok: false; response: Response }
> {
  const gate = await requireConductiaAdmin(request, required);
  if (!gate.ok) return gate;
  const conductiaTenantId = gate.scope.claims?.conductiaTenantId;
  if (!conductiaTenantId) {
    return {
      ok: false,
      response: conductiaError(
        'authentication',
        'Personas require a signed trigger token carrying a tenant claim.',
        401,
      ),
    };
  }
  return { ok: true, scope: gate.scope, conductiaTenantId, admin: gate.admin };
}

/**
 * Hold a persona WRITE to the token's lead: a persona linked to `leadIds`
 * (a new link, or the leads a persona already carries) may only be written by
 * a token whose claim binds to one of them (reads: `personasVisibleToClaim`).
 * An empty list is an unlinked persona, which has no lead to hold it to. Returns the
 * refusal, or null when the write may proceed. Fails closed on a read error.
 */
export async function refusePersonaWriteOffLead(
  gate: { scope: ConductiaScope; admin: SupabaseClient },
  leadIds: string[],
  refusal: () => Response,
): Promise<Response | null> {
  const claimedDealId = gate.scope.claims?.dealId;
  if (leadIds.length === 0) return null;
  if (!claimedDealId) return refusal();
  try {
    for (const leadId of leadIds) {
      if (await claimBindsToLead(gate.admin, claimedDealId, leadId)) return null;
    }
  } catch {
    denyLead(gate.scope, 'binding_read_error');
    return conductiaError('server_error', 'Could not verify the lead binding.', 503);
  }
  denyLead(gate.scope, 'persona_binding');
  return refusal();
}

/**
 * A persona link (on create or on an existing persona) is a write into that
 * lead's persona listing, since listPersonas filters on link.leadId. So the
 * lead must be owned by the token's firm, and be the lead the token was minted
 * for, not merely one of the same firm. The owner is the lead gate's authority
 * (deals.tenant_id, or companies.tenant_id for a company lead), not
 * resolveLeadCompany's: that returns a deal's TARGET company tenant, which can
 * belong to another firm.
 */
export async function refuseLinkOffLead(
  gate: { scope: ConductiaScope; admin: SupabaseClient; conductiaTenantId: string },
  leadId: string,
): Promise<Response | null> {
  let ownerTenantId: string | null;
  try {
    const lead = await loadConductiaLead(gate.admin, leadId, gate.scope.tenantId);
    ownerTenantId = lead?.ownerTenantId ?? null;
  } catch {
    return conductiaError('server_error', 'Failed to load lead', 500);
  }
  // One refusal for a foreign or missing lead and for a same-firm lead the run
  // is not bound to, so the answer does not tell which lead ids exist.
  const refusal = () =>
    conductiaError('scope_denied', 'link.leadId is outside this run.', 403, { field: 'link.leadId' });
  if (!ownerTenantId || ownerTenantId !== gate.conductiaTenantId) return refusal();
  return refusePersonaWriteOffLead(gate, [leadId], refusal);
}

/**
 * The gate every write to an EXISTING persona passes first (update, link): the
 * persona must be in the token's tenant, and the token must be bound to one of
 * its links. An unlinked persona is bound to no lead, so no run edits it (as no
 * run reads it); only its first link is let through (`allowUnlinked`), which is
 * how a run that created it unlinked claims it. Missing, off-lead and unlinked
 * answer the same 404, so a write cannot probe which personas exist. Without
 * this, a token could add its own lead to another lead's persona and then
 * write it.
 *
 * Returns the persona it authorized. The write must land on exactly that
 * version (personas.ts compare-and-sets on it), so a link that changes the
 * persona's leads between this check and the write makes the write miss.
 */
export async function loadPersonaForWrite(
  gate: { scope: ConductiaScope; admin: SupabaseClient; conductiaTenantId: string },
  personaId: string,
  { allowUnlinked = false }: { allowUnlinked?: boolean } = {},
): Promise<{ ok: true; persona: StoredPersona } | { ok: false; response: Response }> {
  const notFound = () => conductiaError('not_found', `No persona ${personaId}.`, 404, { personaId });
  let current;
  try {
    current = await getPersona(gate.admin, gate.scope.tenantId, gate.conductiaTenantId, personaId);
  } catch {
    return { ok: false, response: conductiaError('server_error', 'Failed to load persona', 500) };
  }
  if (!current) return { ok: false, response: notFound() };
  if (current.linkedContacts.length === 0 && !allowUnlinked) {
    denyLead(gate.scope, 'persona_binding');
    return { ok: false, response: notFound() };
  }
  const offLead = await refusePersonaWriteOffLead(
    gate,
    current.linkedContacts.map((link) => link.leadId),
    notFound,
  );
  return offLead ? { ok: false, response: offLead } : { ok: true, persona: current };
}

/**
 * Hold a persona READ to the token's lead: a signed token sees only personas
 * linked to a lead its claim binds to (the write rule's resolution: a deal
 * claim sees its deal and the deal's target company, a company claim its
 * company and the deals targeting it). An unlinked persona is bound to no
 * lead, so no token sees it. A token with no lead claim is refused (403)
 * rather than told no personas exist. Each distinct lead is resolved once per
 * request. Fails closed: a read error answers 503, never a wider list.
 */
export async function personasVisibleToClaim(
  gate: { scope: ConductiaScope; admin: SupabaseClient },
  personas: StoredPersona[],
): Promise<{ ok: true; personas: StoredPersona[] } | { ok: false; response: Response }> {
  const claimedDealId = gate.scope.claims?.dealId;
  if (!claimedDealId) {
    return {
      ok: false,
      response: conductiaError('scope_denied', 'This token is not bound to a lead.', 403),
    };
  }
  const binds = new Map<string, Promise<boolean>>();
  const bindsTo = (leadId: string) => {
    let bound = binds.get(leadId);
    if (!bound) {
      bound = claimBindsToLead(gate.admin, claimedDealId, leadId);
      binds.set(leadId, bound);
    }
    return bound;
  };
  try {
    const visible: StoredPersona[] = [];
    for (const persona of personas) {
      for (const link of persona.linkedContacts) {
        if (await bindsTo(link.leadId)) {
          visible.push(persona);
          break;
        }
      }
    }
    return { ok: true, personas: visible };
  } catch {
    denyLead(gate.scope, 'binding_read_error');
    return {
      ok: false,
      response: conductiaError('server_error', 'Could not verify the lead binding.', 503),
    };
  }
}

/**
 * The scope's agent name and run id are the caller's own x-conductia-* headers,
 * read in auth.ts, so they are sanitised here too (#331, review H2).
 */
function denyLead(scope: ConductiaScope, reason: string): void {
  console.warn(
    `[conductia-seam] ${JSON.stringify({
      outcome: 'deny',
      reason,
      agentName: safeLogId(scope.agentName),
      runId: safeLogId(scope.runId),
    })}`,
  );
}

export async function requireConductiaLead(
  request: Request,
  pathLeadId: string,
  required?: AgentScope,
): Promise<
  | { ok: true; scope: ConductiaScope; lead: ConductiaLead; admin: SupabaseClient }
  | { ok: false; response: Response }
> {
  const gate = requireConductiaScope(request, pathLeadId, required);
  if (!gate.ok) return gate;

  // The shared key is the instance's own credential and carries no tenant
  // claim, so there is nothing to hold the lead to: on a lead route it would
  // reach every firm's data. Only a signed trigger token gets past here, the
  // same rule the persona gate applies.
  if (gate.scope.credential === 'api_key') {
    denyLead(gate.scope, 'api_key');
    return {
      ok: false,
      response: conductiaError(
        'authentication',
        'Lead callbacks require a signed trigger token carrying a tenant claim.',
        401,
      ),
    };
  }

  let admin;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    return {
      ok: false,
      response: conductiaError('server_error', 'Conductia storage is not configured.', 503),
    };
  }

  const leadNotFound = () =>
    conductiaError('not_found', `No deal for lead ${pathLeadId}.`, 404, { leadId: pathLeadId });

  // The binding refusal is the missing-lead 404 too, for the same reason as
  // the tenant wall below: a distinct answer here would tell the token which
  // of another firm's codes exist. The log keeps `binding`.
  if (gate.scope.credential === 'signed_token' && gate.scope.claims) {
    let bound: boolean;
    try {
      bound = await claimBindsToLead(admin, gate.scope.claims.dealId, pathLeadId);
    } catch {
      // The run is authenticated, but a binding nobody could verify is not a
      // grant. Refuse, and let the agent retry once the store answers.
      denyLead(gate.scope, 'binding_read_error');
      return {
        ok: false,
        response: conductiaError('server_error', 'Could not verify the lead binding.', 503),
      };
    }
    if (!bound) {
      denyLead(gate.scope, 'binding');
      return { ok: false, response: leadNotFound() };
    }
  }

  try {
    const lead = await loadConductiaLead(admin, pathLeadId, gate.scope.tenantId);
    if (!lead) return { ok: false, response: leadNotFound() };

    // The TENANT boundary, distinct from the dealId binding above. That one
    // proves the token names this lead; this one proves the lead belongs to
    // the firm the token was minted for. Without it a token for tenant A,
    // genuinely signed and correctly naming lead X, still reads lead X when
    // lead X belongs to tenant B.
    //
    // Enforced once here rather than as a predicate on every query behind it,
    // which is what lets the lead-scoped reads stay keyed on lead_id alone.
    // It fails closed: a token with no tenant claim, or a lead with no owning
    // tenant, has nothing to prove ownership with and is refused too.
    //
    // The refusal is the missing-lead 404, byte for byte, so a token whose
    // claim binds to a lead another firm owns cannot tell that lead from one
    // nobody holds. The log keeps
    // the real reason. `legacy_unsigned` only exists under `observe`, which
    // ADR-0015's rollout owns, so it is not held here.
    if (gate.scope.credential === 'signed_token') {
      const claimedTenant = gate.scope.claims?.conductiaTenantId;
      const reason = !claimedTenant
        ? 'tenant_claim_missing'
        : !lead.ownerTenantId
          ? 'tenant_owner_missing'
          : lead.ownerTenantId !== claimedTenant
            ? 'tenant_binding'
            : null;
      if (reason) {
        denyLead(gate.scope, reason);
        return { ok: false, response: leadNotFound() };
      }
    }

    return { ok: true, scope: gate.scope, lead, admin };
  } catch (error) {
    return {
      ok: false,
      response: conductiaError(
        'server_error',
        error instanceof Error ? error.message : 'Failed to load lead',
        500,
      ),
    };
  }
}
