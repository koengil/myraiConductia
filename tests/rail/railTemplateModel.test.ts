import { describe, expect, it } from 'vitest';

import { MVP_DEAL_RAIL, railSeedRows } from '@/lib/rail/dealRail';
import {
  catalogStepsFromSeed,
  catalogStepsNotOnTemplate,
  presentTemplateSteps,
  railTemplateNameError,
  stepsFromStored,
  summarizeRailTemplates,
} from '@/lib/rail/railTemplateModel';

describe('rail template names', () => {
  it('rejects an empty name and the reserved house name', () => {
    expect(railTemplateNameError('  ')).toBe('Name the template.');
    expect(railTemplateNameError('Default')).toMatch(/house template/);
    expect(railTemplateNameError(' default ')).toMatch(/house template/);
    expect(railTemplateNameError('Rob')).toBeNull();
  });
});

describe('rail template copies', () => {
  it('copies the house rail as catalog steps in display order', () => {
    const seed = railSeedRows(MVP_DEAL_RAIL);
    const steps = catalogStepsFromSeed(seed);
    expect(steps).toHaveLength(seed.length);
    expect(steps[0]).toMatchObject({
      stepId: seed[0]?.stepId,
      origin: 'catalog',
      displayOrder: 1,
      definition: null,
    });
    expect(new Set(steps.map((step) => step.displayOrder)).size).toBe(steps.length);
  });

  it('keeps a saved template’s step order and custom origin', () => {
    const steps = stepsFromStored([
      {
        step_id: 'second',
        seq: 2,
        phase_index: 1,
        display_order: 2,
        origin: 'catalog',
        definition: null,
      },
      {
        step_id: 'first',
        seq: null,
        phase_index: 1,
        display_order: 1,
        origin: 'custom',
        definition: { title: 'Rob step', description: 'Added on the template' },
      },
    ]);
    expect(steps.map((step) => step.stepId)).toEqual(['first', 'second']);
    expect(steps[0]?.origin).toBe('custom');
    expect(steps[0]?.definition).toEqual({
      title: 'Rob step',
      description: 'Added on the template',
    });
  });
});

describe('rail template list', () => {
  it('puts the house default first and names each fork’s source', () => {
    const list = summarizeRailTemplates(
      [
        {
          id: 'rob',
          name: 'Rob',
          forkedFromId: null,
          createdAt: '2026-10-01T00:00:00Z',
          stepCount: 61,
        },
        {
          id: 'other',
          name: 'Other',
          forkedFromId: 'rob',
          createdAt: '2026-10-01T01:00:00Z',
          stepCount: 61,
        },
      ],
      61,
    );

    expect(list.map((template) => template.name)).toEqual(['Default', 'Other', 'Rob']);
    expect(list[0]).toMatchObject({ kind: 'default', id: null, forkedFromName: null });
    expect(list.find((template) => template.name === 'Rob')?.forkedFromName).toBe('Default');
    expect(list.find((template) => template.name === 'Other')?.forkedFromName).toBe('Rob');
    expect(list.find((template) => template.name === 'Other')?.forkedFromRemoved).toBe(false);
  });

  it('keeps the name of a source that was removed', () => {
    const list = summarizeRailTemplates(
      [
        {
          id: 'child',
          name: 'Child',
          forkedFromId: 'gone',
          createdAt: '2026-10-01T01:00:00Z',
          stepCount: 4,
        },
      ],
      61,
      new Map([['gone', 'Rob']]),
    );
    const child = list.find((template) => template.name === 'Child');
    expect(child?.forkedFromName).toBe('Rob');
    expect(child?.forkedFromRemoved).toBe(true);
  });
});

describe('template step presentation', () => {
  it('names catalog and custom steps and hides steps already on the template', () => {
    const catalog = new Map([
      ['p1-s1', { title: 'Target universe', phaseName: 'Origination' }],
    ]);
    const views = presentTemplateSteps(
      [
        {
          id: 'row-1',
          stepId: 'p1-s1',
          seq: 1,
          phaseIndex: 1,
          displayOrder: 2,
          origin: 'catalog',
          definition: null,
        },
        {
          id: 'row-2',
          stepId: 'custom-1',
          seq: null,
          phaseIndex: 1,
          displayOrder: 1,
          origin: 'custom',
          definition: { title: 'Rob check', description: '' },
        },
      ],
      catalog,
      new Map([[1, 'Origination']]),
    );

    expect(views.map((step) => step.title)).toEqual(['Rob check', 'Target universe']);
    expect(
      catalogStepsNotOnTemplate(
        [
          {
            stepId: 'p1-s1',
            seq: 1,
            phaseIndex: 1,
            phaseName: 'Origination',
            title: 'Target universe',
            description: '',
          },
          {
            stepId: 'p1-s2',
            seq: 2,
            phaseIndex: 1,
            phaseName: 'Origination',
            title: 'Next',
            description: '',
          },
        ],
        new Set(views.map((step) => step.stepId)),
      ).map((step) => step.stepId),
    ).toEqual(['p1-s2']);
  });
});

describe('rail template skill steps', () => {
  it('marks a step whose definition holds a skill, and keeps the skill out of the view', () => {
    const views = presentTemplateSteps(
      [
        {
          id: 'row-1',
          stepId: 'p1-s1',
          seq: 1,
          phaseIndex: 1,
          displayOrder: 1,
          origin: 'catalog',
          definition: null,
        },
        {
          id: 'row-2',
          stepId: 'custom-1',
          seq: null,
          phaseIndex: 1,
          displayOrder: 2,
          origin: 'custom',
          definition: { title: 'Rob check', description: '' },
        },
        {
          id: 'row-3',
          stepId: 'custom-2',
          seq: null,
          phaseIndex: 1,
          displayOrder: 3,
          origin: 'custom',
          definition: {
            schemaVersion: 1,
            type: 'skill',
            title: 'Buyer long list',
            description: 'Ranks buyers.',
            inputs: [],
            skill: {
              name: 'Buyer long list',
              contract: { purpose: 'p', expectedInput: 'i', expectedOutput: 'o' },
              source: { kind: 'candidate', candidateId: 'candidate-ref', digest: 'digest-ref' },
            },
          },
        },
      ],
      new Map([['p1-s1', { title: 'Target universe', phaseName: 'Origination' }]]),
      new Map([[1, 'Origination']]),
    );

    expect(views.map((step) => step.hasSkill)).toEqual([false, false, true]);
    expect(views[2].title).toBe('Buyer long list');
    expect(JSON.stringify(views)).not.toContain('candidate-ref');
  });
});
