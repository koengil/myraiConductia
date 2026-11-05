import type { SupabaseClient } from '@supabase/supabase-js';

import { screenMessage } from '@/lib/compliance/screen';
import { COMPANY_TYPE } from '@/lib/constants/companies';
import { DEAL_ROLE, DEAL_ROLES, type DealRole } from '@/lib/constants/roles';
import { codenameMasksCompany } from '@/lib/rail/deals';
import { gate0NoticeText } from '@/lib/rail/gate0';
import type { TemplateSelection } from '@/lib/railTemplates/types';

export type Gate0Member = { userId?: string; dealRole?: string };
export type ConflictsAttestation = { approvedBy?: string; approvedOn?: string };

export type DealCreateBody = {
  codename?: string;
  codenameTheme?: string;
  targetName?: string;
  targetCompanyId?: string;
  entryStepSeq?: number;
  members?: Gate0Member[];
  conflictsAttestation?: ConflictsAttestation;
  requestId?: string;
  railTemplate?: TemplateSelection;
};

export type ValidatedGate0Input = {
  tenantId: string;
  actorId: string;
  bankId: string;
  codename: string;
  targetName: string | null;
  targetCompanyId: string | null;
  codenameTheme: string | null;
  members: Array<{ userId: string; dealRole: string }>;
  screening: { verdict: string; reasons: string[] };
  conflicts: { approvedBy: string; approvedOn: string };
};

export type Gate0InputRejection = {
  status: number;
  body: { error: string; field?: string };
};

export type Gate0InputResult =
  | { ok: true; input: ValidatedGate0Input }
  | { ok: false; rejection: Gate0InputRejection };

const DAY_MS = 24 * 60 * 60 * 1000;

function reject(error: string, status: number, field?: string): Gate0InputResult {
  return { ok: false, rejection: { status, body: field ? { error, field } : { error } } };
}

export async function validateGate0Input(
  admin: SupabaseClient,
  actorId: string,
  body: DealCreateBody,
): Promise<Gate0InputResult> {
  const codename = body.codename?.trim();
  const targetName = body.targetName?.trim();
  const targetCompanyId = body.targetCompanyId?.trim();
  if (!codename) {
    return reject('codename is required', 400);
  }
  if (!targetName && !targetCompanyId) {
    return reject('targetName or targetCompanyId is required', 400);
  }

  const supplied = Array.isArray(body.members) ? body.members : [];
  for (const member of supplied) {
    if (!member.userId) {
      return reject('each member requires a userId', 400);
    }
    if (member.dealRole && !DEAL_ROLES.includes(member.dealRole as DealRole)) {
      return reject(`invalid dealRole "${member.dealRole}"`, 400);
    }
  }
  const members = supplied.map((member) => ({
    userId: member.userId as string,
    dealRole: member.dealRole ?? DEAL_ROLE.DEAL_TEAM,
  }));

  const approvedBy = body.conflictsAttestation?.approvedBy?.trim();
  const approvedOn = body.conflictsAttestation?.approvedOn?.trim();
  if (!approvedBy) {
    return reject('conflictsAttestation.approvedBy is required', 400);
  }
  if (
    !approvedOn ||
    !/^\d{4}-\d{2}-\d{2}$/.test(approvedOn) ||
    Number.isNaN(Date.parse(approvedOn))
  ) {
    return reject('conflictsAttestation.approvedOn must be a date (YYYY-MM-DD)', 400);
  }
  if (Date.parse(approvedOn) > Date.now() + DAY_MS) {
    return reject('conflictsAttestation.approvedOn cannot be in the future', 400);
  }

  const { data: profile, error: profileError } = await admin
    .from('users')
    .select('tenant_id')
    .eq('id', actorId)
    .single();
  if (profileError || !profile) return reject('User profile not found', 404);

  const { data: bank, error: bankError } = await admin
    .from('companies')
    .select('id')
    .eq('tenant_id', profile.tenant_id)
    .eq('type', COMPANY_TYPE.BANK)
    .limit(1)
    .maybeSingle();
  if (bankError) return reject(bankError.message, 500);
  if (!bank) return reject('Bank company not configured for this firm', 503);

  let maskName = targetName ?? '';
  if (targetCompanyId) {
    const { data: target, error: targetError } = await admin
      .from('companies')
      .select('name')
      .eq('id', targetCompanyId)
      .eq('tenant_id', profile.tenant_id)
      .maybeSingle();
    if (targetError) return reject(targetError.message, 500);
    if (!target) return reject('targetCompanyId not found in this firm', 400);
    maskName = target.name as string;
  }

  if (maskName && !codenameMasksCompany(codename, { id: '', name: maskName, sector: '' })) {
    return reject('Code name must not contain the target name', 422, 'codename');
  }

  const screening = screenMessage(gate0NoticeText(codename));

  return {
    ok: true,
    input: {
      tenantId: profile.tenant_id as string,
      actorId,
      bankId: bank.id as string,
      codename,
      targetName: targetName ?? null,
      targetCompanyId: targetCompanyId ?? null,
      codenameTheme: body.codenameTheme?.trim() ?? null,
      members,
      screening: { verdict: screening.verdict, reasons: screening.reasons },
      conflicts: { approvedBy, approvedOn },
    },
  };
}

export function gate0BodyOf(input: ValidatedGate0Input): DealCreateBody {
  return {
    codename: input.codename,
    codenameTheme: input.codenameTheme ?? undefined,
    targetName: input.targetName ?? undefined,
    targetCompanyId: input.targetCompanyId ?? undefined,
    members: input.members,
    conflictsAttestation: input.conflicts,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>);
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(entries.map(([key, item]) => [key, canonical(item)]));
}

export function gate0InputMatches(
  left: ValidatedGate0Input,
  right: ValidatedGate0Input,
): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
