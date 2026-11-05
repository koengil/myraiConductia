import { NextResponse } from 'next/server';
import { classifyInternalUser, listDealsForUser } from '@/lib/api/v1/access';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { PARTY_ROLE } from '@/lib/constants/companies';
import {
  validateGate0Input,
  type DealCreateBody,
} from '@/lib/deals/createDealInput';
import {
  createDealFromTemplate,
  parseTemplateSelection,
} from '@/lib/railTemplates/createDeal';
import {
  requireTemplateFlags,
  templateErrorResponse,
} from '@/lib/railTemplates/access';
import {
  firstStepAfterGate0,
  MVP_DEAL_RAIL,
  phaseForStep,
  railSeedRows,
  stepBySeq,
} from '@/lib/rail/dealRail';
import { RAIL_CENSUS_VERSION } from '@/lib/constants/dealSteps';
import { countStepsByPhase, GATE0_INTAKE_DONE, type CountableStep } from '@/lib/rail/progressCount';
import { provisionDealDataroomOnCreate } from '@/lib/dataroom/steps';
import { errorCodeOf } from '@/lib/errors/upstream';

type DealPartyEmbed = {
  party_role: string;
  company: { name: string } | { name: string }[] | null;
};

type UserEmbed = {
  id: string;
  display_name: string | null;
  full_name: string | null;
  email: string | null;
};

type CurrentStepEmbed = {
  step_id: string;
  seq: number | null;
  phase_index: number | null;
  definition: { title?: string } | null;
  removed_at: string | null;
  assigned_to?: string | null;
  bench_run_status?: string | null;
  assignee?: UserEmbed | UserEmbed[] | null;
};

type StepStatusEmbed = { step_id: string; phase_index: number | null; status: string; removed_at: string | null };

function assigneeOf(embed: UserEmbed | UserEmbed[] | null | undefined) {
  const user = Array.isArray(embed) ? embed[0] : embed;
  if (!user) return null;
  const name = user.display_name?.trim() || user.full_name?.trim() || user.email || null;
  return name ? { id: user.id, name } : null;
}

function currentStepOf(embed: CurrentStepEmbed | CurrentStepEmbed[] | null | undefined, internal: boolean) {
  const step = Array.isArray(embed) ? embed[0] : embed;
  if (!step || step.removed_at) return null;
  return {
    stepId: step.step_id,
    seq: step.seq,
    phaseIndex: step.phase_index,
    title: step.definition?.title ?? null,
    assignee: assigneeOf(step.assignee),
    benchRunStatus: internal ? (step.bench_run_status ?? null) : null,
  };
}

/**
 * Per-phase progress from the deal's own steps (custom steps included), by
 * the rail's own counting rule (src/lib/rail/progressCount.ts), so the
 * Conductor Center's "% done" matches the rail's "N of M steps done". Null
 * when the steps were not read (older schema).
 */
function phaseProgressOf(steps: StepStatusEmbed[] | null | undefined) {
  if (!Array.isArray(steps)) return null;
  const countable: CountableStep[] = steps.map((step) => ({
    stepId: step.step_id,
    phaseIndex: step.phase_index,
    status: step.status,
    removedAt: step.removed_at,
  }));
  return countStepsByPhase(countable, GATE0_INTAKE_DONE);
}

function targetNameOf(parties: DealPartyEmbed[] | null | undefined): string | null {
  const target = (parties ?? []).find((p) => p.party_role === PARTY_ROLE.TARGET);
  if (!target) return null;
  const company = target.company;
  if (Array.isArray(company)) return company[0]?.name ?? null;
  return company?.name ?? null;
}

export async function GET() {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { data, error } = await listDealsForUser(auth.admin, auth.user.id);
  if (error) return jsonError(error.message, 500);

  // Run state and per-phase progress describe the internal rail, which the
  // rail and steps routes withhold from outside parties (403; the step GET
  // nulls benchSession). An outside party, or an unreadable profile, gets
  // null for both. The current step and its assignee stay: every deal
  // accessor already reads them from the step GET.
  const internal = (await classifyInternalUser(auth.admin, auth.user.id)) === 'internal';

  // The caller's deal_role per deal (for the "your role" label on each card).
  const { data: memberships } = await auth.admin
    .from('deal_memberships')
    .select('deal_id, deal_role')
    .eq('user_id', auth.user.id);
  const roleByDeal = new Map<string, string>(
    (memberships ?? []).map((m) => [m.deal_id as string, m.deal_role as string]),
  );

  const deals = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((d) => ({
    id: d.id as string,
    code: d.code as string,
    codename: d.codename as string,
    status: d.status as string,
    createdAt: d.created_at as string,
    entryStepSeq: (d.entry_step_seq as number | null) ?? 1,
    currentStepSeq:
      (d.current_step_seq as number | null) ?? (d.entry_step_seq as number | null) ?? 1,
    currentStep: currentStepOf(d.current_step as CurrentStepEmbed | null, internal),
    phaseProgress: internal ? phaseProgressOf(d.steps as StepStatusEmbed[] | null | undefined) : null,
    targetName: targetNameOf(d.deal_parties as DealPartyEmbed[] | null),
    dealRole: roleByDeal.get(d.id as string) ?? null,
    conflictsApprovedBy: (d.conflicts_approved_by as string | null) ?? null,
    conflictsApprovedOn: (d.conflicts_approved_on as string | null) ?? null,
    targetCloseDate: (d.target_close_date as string | null) ?? null,
    feeUsd: d.fee_usd == null ? null : Number(d.fee_usd),
    scheduleStatus: (d.schedule_status as string | null) ?? null,
    lifecycleCategory: (d.lifecycle_category as string | null) ?? 'live',
  }));

  return NextResponse.json({ deals });
}

/**
 * Create a deal through the full Gate 0 flow. The caller becomes the MD. All
 * writes (target dedupe, deal, parties, memberships, notify fan-out, audit)
 * happen atomically inside the create_deal_gate0 RPC (G5) — this handler only
 * authenticates, validates the mask/roles/attestation, runs compliance
 * screening over the notice text, and delegates.
 *
 * Required: codename + (targetName | targetCompanyId) + conflictsAttestation
 * (the Seq 6 gate — the senior-partner conflicts approval, recorded as
 * approver + date; without it the deal must not exist). members / entryStepSeq
 * / codenameTheme are optional.
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  let body: DealCreateBody;
  try {
    body = (await request.json()) as DealCreateBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const validated = await validateGate0Input(auth.admin, auth.user.id, body);
  if (!validated.ok) {
    return NextResponse.json(validated.rejection.body, {
      status: validated.rejection.status,
    });
  }
  const input = validated.input;

  if (body.railTemplate) {
    const gate = await requireTemplateFlags();
    if (gate) return gate;
    try {
      const receipt = await createDealFromTemplate(
        auth.admin,
        input,
        parseTemplateSelection(body.railTemplate),
        body.requestId ?? '',
      );
      await provisionDataroom(auth.admin, receipt.deal.id, receipt.deal.code);
      return NextResponse.json(receipt, { status: 201 });
    } catch (error) {
      return templateErrorResponse(error, body.requestId);
    }
  }

  const requestedEntry =
    typeof body.entryStepSeq === 'number' && body.entryStepSeq >= 1
      ? stepBySeq(Math.floor(body.entryStepSeq), MVP_DEAL_RAIL)
      : undefined;
  const entryStep = requestedEntry ?? firstStepAfterGate0(MVP_DEAL_RAIL);
  const entryStepSeq = entryStep?.seq ?? 1;
  const entryPhase = entryStep ? (phaseForStep(entryStep.id, MVP_DEAL_RAIL)?.index ?? 1) : 1;

  // The project rail (kept in TS) → per-step rows the RPC seeds (G16). The
  // RPC sets each step's status from entryStepSeq (pre-entry = skipped_entry,
  // entry = current, rest = pending).
  const steps = railSeedRows(MVP_DEAL_RAIL);

  const { data, error } = await auth.admin.rpc('create_deal_gate0', {
    p_tenant_id: input.tenantId,
    p_actor_id: input.actorId,
    p_bank_id: input.bankId,
    p_codename: input.codename,
    p_target_name: input.targetName,
    p_target_company_id: input.targetCompanyId,
    p_codename_theme: input.codenameTheme,
    p_entry_step_seq: entryStepSeq,
    p_entry_phase: entryPhase,
    p_members: input.members,
    p_screening: input.screening,
    p_steps: steps,
    p_census_version: RAIL_CENSUS_VERSION,
    p_conflicts: input.conflicts,
  });

  if (error) {
    const message = error.message || 'Deal create failed';
    const pgCode = (error as { code?: string }).code;
    if (pgCode === '23505' || /codename/i.test(message)) {
      return jsonError('Code name is already in use on a live deal', 409);
    }
    if (/not permitted to create deals/i.test(message)) {
      return jsonError('Not permitted to create deals', 403);
    }
    if (/wall breach/i.test(message)) return jsonError(message, 422);
    if (/invalid deal role/i.test(message)) return jsonError(message, 400);
    if (/conflicts approval/i.test(message)) return jsonError(message, 400);
    if (/no gate0 notify recipient/i.test(message)) {
      return jsonError(
        'No one is assigned to receive new-mandate notices. Assign Receive new-mandate notices on Roles, then try again.',
        400,
      );
    }
    return jsonError(message, 500);
  }

  const result = data as {
    deal: { id: string; code: string };
    memberships: unknown;
    notified: unknown;
  };

  await provisionDataroom(auth.admin, result.deal.id, result.deal.code);

  return NextResponse.json(
    {
      deal: result.deal,
      memberships: result.memberships,
      notified: result.notified,
      screening: input.screening,
    },
    { status: 201 },
  );
}

async function provisionDataroom(
  admin: Parameters<typeof provisionDealDataroomOnCreate>[0],
  dealId: string,
  dealCode: string,
): Promise<void> {
  try {
    await provisionDealDataroomOnCreate(admin, dealId, dealCode);
  } catch (err) {
    console.error('dataroom provision failed at deal create', { dealId, code: errorCodeOf(err) });
  }
}
