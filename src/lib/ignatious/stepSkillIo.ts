import { draftActionLabel } from '@/components/rail/stepActionCopy';
import { manualStepDef } from '@/lib/rail/manualStepDefs';

/** How a rail step feeds a bench skill, and where the reply is written. */
export type StepSkillIo = {
  /**
   * `work` reads saved form boxes on the step.
   * `lead-maps` reads the deal's target + stakeholders + firm relationships.
   */
  source: 'work' | 'lead-maps';
  /** Fields the skill must read when `source` is `work`. Empty means "any filled text field". */
  inputs: readonly string[];
  /** Reply sections → form fields. Unmatched reply goes to `fallback`. */
  outputs: { flags?: string; actions?: string; synthesis?: string; fallback?: string };
};

export const PATHING_BRIEF_FIELD = 'pathing_brief';

const IO_BY_STEP: Record<string, StepSkillIo> = {
  'p1-s8': {
    source: 'lead-maps',
    inputs: [],
    outputs: { synthesis: PATHING_BRIEF_FIELD, fallback: PATHING_BRIEF_FIELD },
  },
  'p1-s10': {
    source: 'work',
    inputs: ['meeting_notes'],
    outputs: { flags: 'sensitivities', actions: 'next_actions', fallback: 'next_actions' },
  },
};

export const STEP_WORK_EVENT = 'ib-step-work';

export type LeadMapsContext = {
  companyId: string;
  companyName: string;
  stakeholders: {
    name: string;
    role_in_decision?: string;
    stance?: string;
    motivation?: string;
    title?: string;
    board_seat?: boolean;
    investor?: boolean;
  }[];
  relationships: {
    person_name: string;
    relationship_type?: string;
    strength?: string;
    confidence?: string;
  }[];
};

export type StepSkillCopy = {
  uses: string;
  idle: string;
  pending: string;
  applied: string;
};

export function stepSkillIo(stepId: string): StepSkillIo {
  return (
    IO_BY_STEP[stepId] ?? {
      source: 'work',
      inputs: [],
      outputs: { fallback: firstTextarea(stepId) },
    }
  );
}

export function stepFilesReply(stepId: string): boolean {
  const outputs = stepSkillIo(stepId).outputs;
  return Boolean(outputs.flags || outputs.actions || outputs.synthesis || outputs.fallback);
}

/** The step's own copy; the button it names comes from `draftActionLabel`. */
export function stepSkillCopy(stepId: string, title: string): StepSkillCopy {
  const draft = draftActionLabel(stepId, title);
  if (stepSkillIo(stepId).source === 'lead-maps') {
    return {
      uses:
        'Uses the target company and the maps above as input and writes advice onto this step. Pick an introducer on each stakeholder, then approve. The draft itself is not a filed path.',
      idle: `Select ${draft} to work from the target and the maps above.`,
      pending: 'Drafting from the target and the maps above…',
      applied: 'Advice written onto the step. Pick an introducer above, then approve.',
    };
  }
  if (stepId === 'p1-s9') {
    return {
      uses:
        'Uses this deal and the public record as input and writes the MD brief and company background onto this step. Review before you mark it complete. Not a filed deal artifact until you do.',
      idle: `Choose the meeting type, then select ${draft}.`,
      pending: 'Drafting the MD brief…',
      applied: 'Brief written onto the step. Review it, then mark complete.',
    };
  }
  if (stepId === 'p1-s10') {
    return {
      uses:
        'Uses the boxes above as input and writes the reply back into this step. Review before you mark it complete. Not a filed deal artifact until you do.',
      idle: `Paste the transcript into Meeting notes, save progress, then select ${draft}.`,
      pending: 'Drafting from the saved boxes above…',
      applied: 'Reply written onto the step. Check the boxes above.',
    };
  }
  if (!stepFilesReply(stepId)) {
    return {
      uses:
        'Uses the boxes above as input and drafts below for you to read. This step has no box to file the reply into, so nothing is written onto the deal.',
      idle: `Fill and save the boxes above first, then select ${draft}.`,
      pending: 'Drafting from the saved boxes above…',
      applied: 'Draft ready below. Copy what you need before you mark the step complete.',
    };
  }
  return {
    uses:
      'Uses the boxes above as input and writes the reply back into this step. Review before you mark it complete. Not a filed deal artifact until you do.',
    idle: `Fill and save the boxes above first, then select ${draft}.`,
    pending: 'Drafting from the saved boxes above…',
    applied: 'Reply written onto the step. Check the boxes above.',
  };
}

export type FilledStepField = {
  id: string;
  label: string;
  value: string;
  kind: 'prose' | 'flag';
};

export function textFieldsFromWork(
  stepId: string,
  work: Record<string, unknown>,
): { id: string; label: string; value: string }[] {
  const def = manualStepDef(stepId);
  if (!def) return [];
  return def.fields
    .filter((field) => field.type === 'text' || field.type === 'textarea')
    .map((field) => {
      const raw = work[field.id];
      return {
        id: field.id,
        label: field.label,
        value: typeof raw === 'string' ? raw.trim() : '',
      };
    })
    .filter((field) => field.value);
}

export function stepWritesProse(stepId: string): boolean {
  const def = manualStepDef(stepId);
  return Boolean(def?.fields.some((field) => field.type === 'text' || field.type === 'textarea'));
}

export function filledFieldsFromWork(
  stepId: string,
  work: Record<string, unknown>,
): FilledStepField[] {
  const def = manualStepDef(stepId);
  if (!def) return [];
  if (stepWritesProse(stepId)) {
    return textFieldsFromWork(stepId, work).map((field) => ({ ...field, kind: 'prose' as const }));
  }
  return def.fields.flatMap((field): FilledStepField[] => {
    const raw = work[field.id];
    if (field.type === 'checkbox') {
      return raw === true
        ? [{ id: field.id, label: field.label, value: field.label, kind: 'flag' }]
        : [];
    }
    if (field.type === 'select') {
      const value = typeof raw === 'string' ? raw.trim() : '';
      return value ? [{ id: field.id, label: field.label, value, kind: 'prose' }] : [];
    }
    return [];
  });
}

export function buildStepSkillPrompt(
  stepId: string,
  stepTitle: string,
  work: Record<string, unknown>,
  maps?: LeadMapsContext | null,
): { ok: true; message: string } | { ok: false; error: string } {
  const io = stepSkillIo(stepId);
  if (io.source === 'lead-maps') {
    return promptFromLeadMaps(stepId, stepTitle, maps);
  }

  const filled = filledFieldsFromWork(stepId, work);
  const required = io.inputs
    .map((id) => filled.find((field) => field.id === id))
    .filter((field): field is FilledStepField => Boolean(field));

  if (io.inputs.length > 0 && required.length === 0) {
    const def = manualStepDef(stepId);
    const labels = io.inputs
      .map((id) => def?.fields.find((field) => field.id === id)?.label ?? id)
      .join(', ');
    return {
      ok: false,
      error: `Save the ${labels} box above first, then select ${draftActionLabel(stepId, stepTitle)}.`,
    };
  }
  if (io.inputs.length === 0 && filled.length === 0) {
    return { ok: false, error: `Fill and save the boxes above first, then select ${draftActionLabel(stepId, stepTitle)}.` };
  }

  const source = required.length > 0 ? required : filled;
  const flags = source.filter((field) => field.kind === 'flag');
  const sections = stepWritesProse(stepId) ? [] : contextSection(stepId);
  sections.push(
    ...source
      .filter((field) => field.kind === 'prose')
      .map((field) => `## ${field.label}\n\n${field.value}`),
  );
  if (flags.length > 0) {
    sections.push(
      `## Checklist confirmed\n\n${flags.map((field) => `- ${field.label}`).join('\n')}`,
    );
  }
  const body = sections.join('\n\n');
  return {
    ok: true,
    message:
      `Run the ${stepTitle} skill against the step inputs below. ` +
      `Return a flags / sensitivities section and an action register / next actions section ` +
      `as markdown headings so they can be filed back onto the deal.\n\n${body}`,
  };
}

type ApiParty = {
  party_role?: string;
  company?: { id?: string; name?: string } | { id?: string; name?: string }[] | null;
};

/** Load the deal's target company and lead maps for a `lead-maps` skill. */
export async function loadLeadMapsForDeal(dealId: string): Promise<LeadMapsContext | null> {
  const dealRes = await fetch(`/api/v1/deals/${encodeURIComponent(dealId)}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!dealRes.ok) return null;
  const dealBody = (await dealRes.json()) as { parties?: ApiParty[] };
  const target = (dealBody.parties ?? []).find((party) => party.party_role === 'target');
  const rawCompany = target?.company;
  const company = Array.isArray(rawCompany) ? rawCompany[0] : rawCompany;
  const companyId = company?.id?.trim();
  const companyName = company?.name?.trim();
  if (!companyId || !companyName) return null;

  const [stkRes, relRes] = await Promise.all([
    fetch(`/api/v1/companies/${companyId}/stakeholders`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    }),
    fetch(`/api/v1/companies/${companyId}/relationships`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    }),
  ]);
  const stkBody = stkRes.ok
    ? ((await stkRes.json()) as { stakeholders?: LeadMapsContext['stakeholders'] })
    : { stakeholders: [] };
  const relBody = relRes.ok
    ? ((await relRes.json()) as { relationships?: LeadMapsContext['relationships'] })
    : { relationships: [] };

  return {
    companyId,
    companyName,
    stakeholders: stkBody.stakeholders ?? [],
    relationships: relBody.relationships ?? [],
  };
}

function promptFromLeadMaps(
  stepId: string,
  stepTitle: string,
  maps?: LeadMapsContext | null,
): { ok: true; message: string } | { ok: false; error: string } {
  if (!maps?.companyName) {
    return {
      ok: false,
      error: `This deal has no linked target company. Add the lead first, then select ${draftActionLabel(stepId, stepTitle)}.`,
    };
  }

  const people = maps.stakeholders.length
    ? maps.stakeholders
        .map((row) => {
          const bits = [
            row.role_in_decision,
            row.title,
            row.stance,
            row.investor ? 'investor' : null,
            row.board_seat ? 'board' : null,
          ].filter(Boolean);
          return `- ${row.name}${bits.length ? ` — ${bits.join(' · ')}` : ''}`;
        })
        .join('\n')
    : 'None mapped yet.';
  const rels = maps.relationships.length
    ? maps.relationships
        .map((row) => {
          const bits = [row.relationship_type, row.strength, row.confidence].filter(Boolean);
          return `- ${row.person_name}${bits.length ? ` — ${bits.join(', ')}` : ''}`;
        })
        .join('\n')
    : 'None on record yet.';

  return {
    ok: true,
    message:
      `Run the ${stepTitle} skill for this target. ` +
      `The maps below are the live deal record. Use them as the source of truth. ` +
      `Do not call Conductia or any other system for this run. ` +
      `Return a decision map and the best paths (named introducer, confidence, and gaps) ` +
      `as markdown so they can be reviewed on the deal.\n\n` +
      `## Target\n\n${maps.companyName}\n\n` +
      `## Stakeholders already mapped\n\n${people}\n\n` +
      `## Firm relationships\n\n${rels}`,
  };
}

export function applySkillReply(
  stepId: string,
  work: Record<string, unknown>,
  reply: string,
): Record<string, unknown> {
  const io = stepSkillIo(stepId);
  const flags = sectionNamed(reply, ['flag', 'sensitivit', 'risk']);
  const actions = sectionNamed(reply, ['action', 'next step', 'next action', 'register']);
  const next = { ...work };
  if (io.outputs.flags && flags) next[io.outputs.flags] = flags;
  if (io.outputs.actions && actions) next[io.outputs.actions] = actions;
  if (io.outputs.synthesis) next[io.outputs.synthesis] = reply.trim();
  if (!flags && !actions && io.outputs.fallback) {
    next[io.outputs.fallback] = reply.trim();
  }
  return next;
}

function contextSection(stepId: string): string[] {
  const summary = manualStepDef(stepId)?.summary?.trim();
  return summary ? [`## Step context\n\n${summary}`] : [];
}

function firstTextarea(stepId: string): string | undefined {
  return manualStepDef(stepId)?.fields.find((field) => field.type === 'textarea')?.id;
}

function sectionNamed(markdown: string, needles: readonly string[]): string | null {
  const chunks = markdown.split(/^#{1,3}\s+/m);
  for (const chunk of chunks) {
    const [title, ...rest] = chunk.split(/\n/);
    if (!title) continue;
    const hay = title.toLowerCase();
    if (!needles.some((needle) => hay.includes(needle))) continue;
    const body = rest.join('\n').trim();
    if (body) return body;
  }
  return null;
}
