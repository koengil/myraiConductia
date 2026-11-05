import { describe, expect, it } from 'vitest';

import { displayOrderForPlacement, presentTemplateChanges } from '@/lib/rail/templateChanges';

const steps = [
  { id: 'a', stepId: 'p1', phaseIndex: 1, displayOrder: 1 },
  { id: 'b', stepId: 'p2', phaseIndex: 1, displayOrder: 2 },
  { id: 'c', stepId: 'p3', phaseIndex: 2, displayOrder: 3 },
];

describe('template step placement', () => {
  it('puts a step at the start, the end, or after a chosen step', () => {
    expect(displayOrderForPlacement(steps, { kind: 'phase_start', phaseIndex: 1 })).toBe(1);
    expect(displayOrderForPlacement(steps, { kind: 'phase_end', phaseIndex: 1 })).toBe(3);
    expect(displayOrderForPlacement(steps, { kind: 'after', phaseIndex: 1, afterStepId: 'a' })).toBe(2);
    expect(displayOrderForPlacement(steps, { kind: 'phase_start', phaseIndex: 3 })).toBe(4);
    expect(displayOrderForPlacement(steps, { kind: 'after', phaseIndex: 1, afterStepId: 'missing' })).toBeNull();
  });
});

describe('template change history', () => {
  it('lets a change be reversed once, as a new change', () => {
    const views = presentTemplateChanges(
      [
        {
          id: 'undo-1',
          action: 'remove_step',
          summary: 'Removed "Probe"',
          createdAt: '2026-10-01T02:00:00Z',
          actorName: 'Rob',
          undoesId: 'add-1',
          before: { stepId: 'custom-probe', stepRowId: 'row-probe' },
          after: null,
        },
        {
          id: 'add-1',
          action: 'add_step',
          summary: 'Added "Probe"',
          createdAt: '2026-10-01T01:00:00Z',
          actorName: 'Rob',
          undoesId: null,
          before: null,
          after: { stepRowId: 'row-probe', stepId: 'custom-probe' },
        },
      ],
      steps,
    );

    expect(views.find((change) => change.id === 'add-1')?.canUndo).toBe(false);
    expect(views.find((change) => change.id === 'undo-1')?.canUndo).toBe(true);
  });

  it('removes the skill block from the definitions it presents and keeps the rest', () => {
    const CANDIDATE = '33333333-3333-4333-8333-333333333333';
    const definition = {
      title: 'Weekly memo',
      description: 'Draft a memo',
      type: 'skill',
      inputs: ['period'],
      skill: {
        contract: { purpose: 'p' },
        source: { kind: 'candidate', candidateId: CANDIDATE, digest: 'd'.repeat(64) },
      },
    };
    const [view] = presentTemplateChanges(
      [
        {
          id: 'c1',
          action: 'set_description',
          summary: 'Edited',
          createdAt: '2026-10-01T01:00:00Z',
          actorName: 'Rob',
          undoesId: null,
          before: { stepRowId: 'a', stepId: 'p1', definition },
          after: { stepRowId: 'a', stepId: 'p1', definition: { ...definition, description: 'New' } },
        },
      ],
      steps,
    );

    for (const side of [view.before, view.after]) {
      const shown = side?.definition as Record<string, unknown>;
      expect(shown).not.toHaveProperty('skill');
      expect(shown).toMatchObject({ title: 'Weekly memo', type: 'skill', inputs: ['period'] });
      expect(side).toMatchObject({ stepRowId: 'a', stepId: 'p1' });
    }
    expect((view.after?.definition as Record<string, unknown>).description).toBe('New');
    expect(JSON.stringify(view)).not.toContain(CANDIDATE);
    expect(definition).toHaveProperty('skill');
  });

  it('leaves manual steps, a null side and a null definition unchanged', () => {
    const base = {
      createdAt: '2026-10-01T01:00:00Z',
      actorName: 'Rob',
      undoesId: null,
      summary: 'x',
    };
    const manual = { stepRowId: 'a', stepId: 'p1', definition: { title: 'Checklist', description: 'Manual' } };
    const nullDefinition = { stepRowId: 'b', stepId: 'p2', definition: null };
    const views = presentTemplateChanges(
      [
        { ...base, id: 'm', action: 'add_step', before: null, after: manual },
        { ...base, id: 'n', action: 'remove_step', before: nullDefinition, after: null },
      ],
      steps,
    );

    expect(views[0].before).toBeNull();
    expect(views[0].after).toEqual(manual);
    expect(views[1].before).toEqual(nullDefinition);
    expect(views[1].after).toBeNull();
  });

  it('lists a template description change and a step skill change, each undoable once', () => {
    const views = presentTemplateChanges(
      [
        {
          id: 'describe-1',
          action: 'set_template_description',
          summary: 'Updated the template description',
          createdAt: '2026-10-07T01:00:00Z',
          actorName: 'Rob',
          undoesId: null,
          before: { description: '' },
          after: { description: 'For carve-outs.' },
        },
        {
          id: 'skill-1',
          action: 'set_step_skill',
          summary: 'Updated the skill of "Probe"',
          createdAt: '2026-10-07T02:00:00Z',
          actorName: 'Rob',
          undoesId: null,
          before: { stepRowId: 'a', stepId: 'p1', definition: null },
          after: {
            stepRowId: 'a',
            stepId: 'p1',
            definition: {
              skill: {
                name: 'Probe',
                source: { kind: 'candidate', candidateId: 'candidate-ref', digest: 'd' },
              },
            },
          },
        },
        {
          id: 'skill-gone',
          action: 'set_step_skill',
          summary: 'Updated the skill of "Gone"',
          createdAt: '2026-10-07T03:00:00Z',
          actorName: 'Rob',
          undoesId: null,
          before: { stepRowId: 'missing' },
          after: { stepRowId: 'missing' },
        },
      ],
      steps,
    );

    expect(views.map((view) => view.canUndo)).toEqual([true, true, false]);
    expect(JSON.stringify(views)).not.toContain('candidate-ref');
  });

  it('names a house step by the title the rail shows, and a custom step as it was written', () => {
    const base = { createdAt: '2026-10-09T01:00:00Z', actorName: 'Rob', undoesId: null };
    const views = presentTemplateChanges(
      [
        {
          ...base,
          id: 'remove-house',
          action: 'remove_step',
          summary: 'Removed "p2-s27"',
          before: { stepRowId: 'row-house', stepId: 'p2-s27', title: 'p2-s27' },
          after: null,
        },
        {
          ...base,
          id: 'describe-house',
          action: 'set_description',
          summary: 'Updated the description of "p1-s7"',
          before: { stepRowId: 'a', stepId: 'p1-s7', description: '' },
          after: { stepRowId: 'a', stepId: 'p1-s7', description: 'Ask the client first.' },
        },
        {
          ...base,
          id: 'remove-custom',
          action: 'remove_step',
          summary: 'Removed "Probe"',
          before: { stepRowId: 'row-probe', stepId: 'custom-probe', title: 'Probe' },
          after: null,
        },
      ],
      steps,
    );

    expect(views.map((view) => view.summary)).toEqual([
      'Removed "Win/Loss Debrief"',
      'Updated the description of "Codename"',
      'Removed "Probe"',
    ]);
  });
});
