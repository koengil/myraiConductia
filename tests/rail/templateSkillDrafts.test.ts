import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { TABLE } from '@/lib/constants/tables';
import {
  publishTemplateSkillDraft,
  templateSkillStepDefinition,
} from '@/lib/rail/templateSkillDrafts';
import type { CandidatePreview } from '@/lib/skillAuthoring/types';

const TEMPLATE = '77777777-0000-4000-8000-000000000001';
const DRAFT = '88888888-0000-4000-8000-000000000001';
const CANDIDATE = '99999999-0000-4000-8000-000000000001';
const DIGEST = 'a'.repeat(64);

const PURPOSE = 'Builds a ranked long list of strategic buyers.';
const EXPECTED_INPUT = 'The sector and size of the target.';
const EXPECTED_OUTPUT = 'A ranked list of buyers with a reason for each.';

function candidate(overrides: Partial<CandidatePreview> = {}): CandidatePreview {
  return {
    id: CANDIDATE,
    digest: DIGEST,
    schemaVersion: 1,
    name: 'buyer-long-list',
    purpose: PURPOSE,
    expectedInput: EXPECTED_INPUT,
    expectedOutput: EXPECTED_OUTPUT,
    inputs: [],
    ...overrides,
  };
}

const SKILL_STEP = {
  schemaVersion: 1,
  type: 'skill',
  title: 'Buyer long list',
  description: PURPOSE,
  inputs: [
    { key: 'primary', kind: 'text', label: 'Input', helperText: EXPECTED_INPUT, required: true },
  ],
  skill: {
    name: 'Buyer long list',
    contract: { purpose: PURPOSE, expectedInput: EXPECTED_INPUT, expectedOutput: EXPECTED_OUTPUT },
    source: { kind: 'candidate', candidateId: CANDIDATE, digest: DIGEST },
  },
};

function draftRow(preview: CandidatePreview = candidate()) {
  return {
    id: DRAFT,
    template_id: TEMPLATE,
    status: 'active',
    name: ' Buyer long list ',
    placement: { kind: 'phase_end', phaseIndex: 1 },
    composer_text: '',
    edit_revision: 3,
    messages: [],
    candidate: preview,
  };
}

function adminWith(draft: Record<string, unknown>) {
  const rpc = vi.fn<
    (name: string, params: Record<string, unknown>) => Promise<{ data: { id: string }; error: null }>
  >(async () => ({ data: { id: 'step-row-1' }, error: null }));
  const admin = {
    from: (table: string) => {
      const rows = table === TABLE.RAIL_CATALOG_SKILL_DRAFTS ? [draft] : [];
      const query = {
        select: () => query,
        eq: () => query,
        update: () => query,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => void) => resolve({ data: rows, error: null }),
      };
      return query;
    },
    rpc,
  } as unknown as SupabaseClient;
  return { admin, rpc };
}

const SAVE = {
  companyId: 'co-bank',
  authorId: 'user-1',
  templateId: TEMPLATE,
  draftId: DRAFT,
  expectedEditRevision: 3,
  candidateId: CANDIDATE,
  candidateDigest: DIGEST,
};

describe('templateSkillStepDefinition', () => {
  it('builds a skill step that keeps the candidate reference', () => {
    expect(templateSkillStepDefinition(' Buyer long list ', candidate())).toEqual(SKILL_STEP);
  });

  it.each([
    ['an empty name', '  ', {}],
    ['an empty expected output', 'Buyer long list', { expectedOutput: '  ' }],
    ['an empty expected input', 'Buyer long list', { expectedInput: '' }],
    ['a purpose over 2,000 characters', 'Buyer long list', { purpose: 'x'.repeat(2001) }],
    ['a candidate id that is not a UUID', 'Buyer long list', { id: 'candidate-1' }],
    ['a digest that is not 64 hex characters', 'Buyer long list', { digest: 'abc' }],
  ])('refuses %s', (_label, name, overrides) => {
    expect(templateSkillStepDefinition(name, candidate(overrides))).toBeNull();
  });
});

describe('publishTemplateSkillDraft', () => {
  it('adds a custom step whose definition holds the skill', async () => {
    const { admin, rpc } = adminWith(draftRow());

    const result = await publishTemplateSkillDraft(admin, SAVE);

    expect(result).toEqual({ stepId: 'step-row-1', digest: DIGEST });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, params] = rpc.mock.calls[0];
    expect(name).toBe('add_rail_template_step');
    expect(params).toMatchObject({
      p_company_id: 'co-bank',
      p_actor_id: 'user-1',
      p_template_id: TEMPLATE,
      p_origin: 'custom',
      p_phase_index: 1,
    });
    expect(params.p_step_id).toMatch(/^custom-[0-9a-f-]{36}$/);
    expect(params.p_definition).toEqual(SKILL_STEP);
  });

  it('refuses a candidate with an incomplete contract and adds no step', async () => {
    const { admin, rpc } = adminWith(draftRow(candidate({ expectedOutput: '' })));

    const result = await publishTemplateSkillDraft(admin, SAVE);

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: 'Generate a candidate skill before saving.',
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});
